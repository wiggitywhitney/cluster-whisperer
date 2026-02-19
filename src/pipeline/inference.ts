/**
 * inference.ts - LLM capability inference for the pipeline (M2)
 *
 * Takes discovered resources (from M1) and sends their schemas to an LLM
 * to generate structured capability descriptions. The LLM analyzes each
 * resource's kubectl explain output and returns what the resource does,
 * which providers it supports, and how complex it is to use.
 *
 * The output (ResourceCapability[]) feeds directly into M3's vector storage.
 *
 * Key design choices:
 * - Uses Claude Haiku for speed and cost (batch-processing dozens of schemas)
 * - Zod + withStructuredOutput() guarantees valid JSON responses
 * - Sequential processing (cluster schemas total ~3 seconds, no need for parallelism)
 * - Injectable model for testing (same DI pattern as DiscoveryOptions.kubectl)
 */

import { ChatAnthropic } from "@langchain/anthropic";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import type {
  DiscoveredResource,
  ResourceCapability,
  LlmCapabilityResult,
  InferenceOptions,
} from "./types";

// ---------------------------------------------------------------------------
// Zod schema for structured LLM output
// ---------------------------------------------------------------------------

/**
 * Zod schema defining the shape of the LLM's structured response.
 *
 * Used with ChatAnthropic.withStructuredOutput() which leverages Anthropic's
 * tool_use under the hood — the LLM is constrained to return valid JSON
 * matching this schema. No manual JSON parsing or regex needed.
 *
 * The .describe() calls become part of the tool schema the LLM sees,
 * helping it understand what each field means.
 */
export const LlmCapabilitySchema = z.object({
  capabilities: z
    .array(z.string())
    .describe(
      "Functional capabilities this resource provides, as lowercase search terms (e.g., 'database', 'postgresql', 'load-balancer')"
    ),
  providers: z
    .array(z.string())
    .describe(
      "Cloud providers this resource supports, lowercase (e.g., 'aws', 'gcp', 'azure'). Empty array if provider-agnostic."
    ),
  complexity: z
    .enum(["low", "medium", "high"])
    .describe(
      "How complex the resource is to use: 'low' = few fields, 'medium' = several fields, 'high' = many nested fields"
    ),
  description: z
    .string()
    .describe(
      "1-2 sentence description of what this resource does, for a developer who has never seen it"
    ),
  useCase: z
    .string()
    .describe(
      "When and why a developer would use this resource. Start with a verb like 'Deploy', 'Configure', 'Manage'."
    ),
  confidence: z
    .number()
    .min(0)
    .max(1)
    .describe(
      "Confidence in the analysis: 0.9+ for detailed schemas, 0.5-0.8 for sparse ones, below 0.5 for minimal info"
    ),
});

// ---------------------------------------------------------------------------
// Prompt template loading
// ---------------------------------------------------------------------------

/**
 * Path to the capability inference prompt template.
 * Goes from src/pipeline/ up to project root, then into prompts/.
 */
const promptPath = path.join(
  __dirname,
  "../../prompts/capability-inference.md"
);

/** Cached prompt template — loaded lazily on first use. */
let cachedPrompt: string | null = null;

/**
 * Loads the prompt template from disk, caching it for reuse.
 * Provides a clear error message if the file is missing.
 */
function getPromptTemplate(): string {
  if (!cachedPrompt) {
    try {
      cachedPrompt = fs.readFileSync(promptPath, "utf8");
    } catch {
      console.error(
        `Error: Could not load prompt template from ${promptPath}`
      );
      console.error(
        "Make sure prompts/capability-inference.md exists in the project root."
      );
      process.exit(1);
    }
  }
  return cachedPrompt;
}

// ---------------------------------------------------------------------------
// Default model creation
// ---------------------------------------------------------------------------

/**
 * The Anthropic model used for batch capability inference.
 *
 * Haiku is chosen over Sonnet for this use case because:
 * - We process dozens of schemas sequentially
 * - Schema analysis doesn't need deep reasoning
 * - Haiku is faster and cheaper for structured extraction
 *
 * Sonnet is reserved for the investigator agent where reasoning depth matters.
 */
const INFERENCE_MODEL = "claude-haiku-4-5-20251001";

/** Cached default model — created lazily on first use. */
let cachedModel: {
  invoke: (messages: Array<[string, string]>) => Promise<LlmCapabilityResult>;
} | null = null;

/**
 * Creates the default structured model for inference.
 * Uses ChatAnthropic with withStructuredOutput() to guarantee valid JSON.
 */
function getDefaultModel(): {
  invoke: (messages: Array<[string, string]>) => Promise<LlmCapabilityResult>;
} {
  if (!cachedModel) {
    const llm = new ChatAnthropic({
      model: INFERENCE_MODEL,
      maxTokens: 1024,
    });

    // withStructuredOutput() wraps the model so it always returns parsed JSON
    // matching our Zod schema. Under the hood, it uses Anthropic's tool_use
    // feature to constrain the output format.
    cachedModel = llm.withStructuredOutput(LlmCapabilitySchema) as unknown as {
      invoke: (
        messages: Array<[string, string]>
      ) => Promise<LlmCapabilityResult>;
    };
  }
  return cachedModel;
}

// ---------------------------------------------------------------------------
// Inference functions
// ---------------------------------------------------------------------------

/**
 * Builds the human message content for a single resource.
 *
 * Includes the resource name, kind, and full schema so the LLM has
 * context about what it's analyzing. The system message (prompt template)
 * provides the instructions.
 */
function buildHumanMessage(resource: DiscoveredResource): string {
  return [
    `Resource: ${resource.name}`,
    `Kind: ${resource.kind}`,
    `API Version: ${resource.apiVersion}`,
    "",
    "Schema (kubectl explain --recursive):",
    "```",
    resource.schema,
    "```",
  ].join("\n");
}

/**
 * Infers capabilities for a single Kubernetes resource.
 *
 * Sends the resource's schema to the LLM with the prompt template and
 * returns a ResourceCapability combining the resource metadata with the
 * LLM's structured analysis.
 *
 * @param resource - A discovered resource with schema text from M1
 * @param options - Injectable model and progress callback for testing
 * @returns ResourceCapability with both metadata and LLM-inferred fields
 * @throws Error with resource context if the LLM call fails
 */
export async function inferCapability(
  resource: DiscoveredResource,
  options?: InferenceOptions
): Promise<ResourceCapability> {
  const model = options?.model ?? getDefaultModel();

  const messages: Array<[string, string]> = [
    ["system", getPromptTemplate()],
    ["human", buildHumanMessage(resource)],
  ];

  let llmResult: LlmCapabilityResult;
  try {
    llmResult = await model.invoke(messages);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Failed to infer capabilities for ${resource.name}: ${message}`
    );
  }

  return {
    // Resource metadata from M1
    resourceName: resource.name,
    apiVersion: resource.apiVersion,
    group: resource.group,
    kind: resource.kind,
    // LLM-inferred fields
    ...llmResult,
  };
}

/**
 * Infers capabilities for multiple resources sequentially.
 *
 * Processes each resource one at a time, skipping any where the LLM fails.
 * Reports progress via callback so callers can show "Inferring (3 of 47)".
 *
 * Why sequential and not parallel?
 * - Total wall time for a cluster is typically under a minute
 * - Sequential is simpler to debug and reason about
 * - Avoids rate limit concerns with the Anthropic API
 * - Progress reporting is clearer with sequential processing
 *
 * @param resources - Array of discovered resources from M1
 * @param options - Injectable model and progress callback for testing
 * @returns Array of ResourceCapability for successfully processed resources
 */
export async function inferCapabilities(
  resources: DiscoveredResource[],
  options?: InferenceOptions
): Promise<ResourceCapability[]> {
  const onProgress = options?.onProgress ?? console.log;
  const results: ResourceCapability[] = [];

  for (let i = 0; i < resources.length; i++) {
    const resource = resources[i];
    onProgress(
      `Inferring capabilities (${i + 1} of ${resources.length}): ${resource.name}`
    );

    try {
      const capability = await inferCapability(resource, options);
      results.push(capability);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      onProgress(`  Warning: skipping ${resource.name} (${message})`);
    }
  }

  onProgress(
    `Inference complete: ${results.length} of ${resources.length} resources processed.`
  );
  return results;
}
