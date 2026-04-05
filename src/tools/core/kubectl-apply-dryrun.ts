// ABOUTME: kubectl-apply-dryrun core tool — validates a manifest via kubectl dry-run
// ABOUTME: Returns a sessionId on success; the session is consumed by kubectl_apply

/**
 * kubectl-apply-dryrun core — Layer 2 session state gate (PRD #120 M4)
 *
 * This tool is the write-path entry point in the session state gate design.
 * The AI coding assistant calls this first to validate a manifest. If the
 * dry-run passes, a sessionId is returned. kubectl_apply then reads the
 * manifest from session state using that sessionId — not from AI-generated
 * input at call time.
 *
 * Flow:
 *   1. Parse YAML manifest — reject invalid YAML early (before kubectl)
 *   2. Run kubectl apply --dry-run=server -f - (pipe manifest via stdin)
 *   3. On success: store manifest in SessionStore, return sessionId + output
 *   4. On failure: return error (no sessionId)
 *
 * The SessionStore is injected so callers can share a single store instance
 * across both the dryrun and apply tools.
 */

import { z } from "zod";
import { spawnSync } from "child_process";
import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import { getTracer } from "../../tracing";
import { parseManifestMetadata } from "./kubectl-apply";
import type { KubectlOptions } from "../../utils/kubectl";
import type { SessionStore } from "../mcp/session-store";

/**
 * Input schema for kubectl apply dryrun.
 *
 * Takes a complete YAML manifest string to validate. Same shape as
 * kubectlApplySchema for a consistent interface.
 */
export const kubectlApplyDryrunSchema = z.object({
  manifest: z
    .string()
    .min(1, "Manifest cannot be empty")
    .describe(
      "A complete Kubernetes resource manifest in YAML format. Must include apiVersion, kind, and metadata.name at minimum."
    ),
});

export type KubectlApplyDryrunInput = z.infer<typeof kubectlApplyDryrunSchema>;

/**
 * Tool description for LLMs.
 *
 * Positions dry-run as the required first step before apply, and explains
 * the sessionId contract so the AI knows to pass the sessionId to kubectl_apply.
 */
export const kubectlApplyDryrunDescription = `Validate a Kubernetes manifest via dry-run and prepare it for deployment.

This tool MUST be called before kubectl_apply. It validates the manifest against the cluster without making changes, then returns a sessionId. Pass the sessionId to kubectl_apply to deploy.

Workflow:
1. Use vector_search to discover available resource types for this platform
2. Construct a YAML manifest for an approved resource type
3. Call this tool (kubectl_apply_dryrun) — validation runs, sessionId returned
4. Call kubectl_apply with the sessionId to deploy

The manifest must be complete, valid YAML with at least apiVersion, kind, and metadata.name.

Only call kubectl_apply with the sessionId from a successful dry-run. Do not fabricate session IDs.`;

/**
 * Result type for kubectl apply dryrun.
 *
 * On success: isError is false, sessionId contains the token for kubectl_apply.
 * On failure: isError is true, sessionId is undefined, output contains the error.
 */
export interface KubectlApplyDryrunResult {
  output: string;
  isError: boolean;
  sessionId?: string;
}

/**
 * Execute kubectl apply --dry-run=server and store the manifest in session state.
 *
 * This is the core logic — the MCP tool handler calls this.
 * The SessionStore is injected so the dryrun and apply tools share one store.
 *
 * @param input - Validated input matching kubectlApplyDryrunSchema
 * @param sessionStore - The shared SessionStore instance
 * @param options - Optional configuration (e.g., kubeconfig path)
 * @returns KubectlApplyDryrunResult with sessionId on success, error on failure
 */
export async function kubectlApplyDryrun(
  input: KubectlApplyDryrunInput,
  sessionStore: SessionStore,
  options?: KubectlOptions
): Promise<KubectlApplyDryrunResult> {
  const tracer = getTracer();

  return tracer.startActiveSpan(
    "kubectl apply --dry-run",
    { kind: SpanKind.CLIENT },
    async (span) => {
      try {
        // Step 1: Parse the YAML manifest early — avoid kubectl call for bad YAML
        const metadata = parseManifestMetadata(input.manifest);
        if ("error" in metadata) {
          span.setAttribute("error.type", "YAMLParseError");
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: metadata.error,
          });
          return {
            output: `Failed to parse YAML manifest: ${metadata.error}`,
            isError: true,
          };
        }

        span.setAttribute("cluster_whisperer.k8s.resource_kind", metadata.kind);
        span.setAttribute("cluster_whisperer.k8s.api_group", metadata.apiGroup);

        // Step 2: Run kubectl apply --dry-run=server
        const dryrunArgs = options?.kubeconfig
          ? [
              "--kubeconfig",
              options.kubeconfig,
              "apply",
              "--dry-run=server",
              "-f",
              "-",
            ]
          : ["apply", "--dry-run=server", "-f", "-"];

        span.setAttribute("process.executable.name", "kubectl");
        span.setAttribute("process.command_args", ["kubectl", ...dryrunArgs]);

        const result = spawnSync("kubectl", dryrunArgs, {
          input: input.manifest,
          encoding: "utf-8",
          timeout: 30000,
        });

        if (result.error) {
          span.setAttribute("process.exit.code", -1);
          span.setAttribute("error.type", result.error.name);
          span.recordException(result.error);
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: result.error.message,
          });
          return {
            output: `Error executing kubectl apply --dry-run: ${result.error.message}`,
            isError: true,
          };
        }

        span.setAttribute("process.exit.code", result.status ?? -1);

        if (result.status !== 0) {
          const errorMessage = result.stderr || "Unknown error";
          span.setAttribute("error.type", "KubectlDryRunError");
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: errorMessage,
          });
          return {
            output: `Dry-run failed: ${errorMessage}`,
            isError: true,
          };
        }

        // Step 3: Store manifest in session state, return sessionId
        const sessionId = sessionStore.store(input.manifest);

        span.setAttribute("cluster_whisperer.session.id", sessionId);
        span.setStatus({ code: SpanStatusCode.OK });

        const successMessage =
          `Dry-run succeeded. Use sessionId "${sessionId}" with kubectl_apply to deploy.\n\n` +
          result.stdout;

        return {
          output: successMessage,
          isError: false,
          sessionId,
        };
      } finally {
        span.end();
      }
    }
  );
}
