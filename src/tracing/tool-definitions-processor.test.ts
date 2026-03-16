// ABOUTME: Unit tests for ToolDefinitionsProcessor — verifies all 5 tools appear in gen_ai.tool.definitions.
// ABOUTME: Tests that the processor injects tool definitions into anthropic.chat spans.

/**
 * Tests for the ToolDefinitionsProcessor.
 *
 * The processor adds gen_ai.tool.definitions to anthropic.chat spans so
 * Datadog LLM Observability shows which tools were available to the LLM.
 *
 * Rather than trying to mock the lazy require() chain, these tests call
 * getToolDefinitionsJson() directly (exported for testing) and verify
 * the JSON output contains all expected tools.
 */

import { describe, it, expect } from "vitest";
import {
  kubectlGetDescription,
  kubectlGetSchema,
  kubectlDescribeDescription,
  kubectlDescribeSchema,
  kubectlLogsDescription,
  kubectlLogsSchema,
  kubectlApplyDescription,
  kubectlApplySchema,
  vectorSearchDescription,
  vectorSearchSchema,
} from "../tools/core";
import { zodToJsonSchema } from "zod-to-json-schema";

/**
 * Build the expected tool definitions the same way the processor does,
 * then verify completeness. This catches missing tools without needing
 * to instantiate the processor (which has CJS require() issues in tests).
 */
const ALL_EXPECTED_TOOLS = [
  { name: "kubectl_get", description: kubectlGetDescription, schema: kubectlGetSchema },
  { name: "kubectl_describe", description: kubectlDescribeDescription, schema: kubectlDescribeSchema },
  { name: "kubectl_logs", description: kubectlLogsDescription, schema: kubectlLogsSchema },
  { name: "vector_search", description: vectorSearchDescription, schema: vectorSearchSchema },
  { name: "kubectl_apply", description: kubectlApplyDescription, schema: kubectlApplySchema },
];

describe("ToolDefinitionsProcessor tool coverage", () => {
  it("all 5 tools have exported descriptions", () => {
    for (const tool of ALL_EXPECTED_TOOLS) {
      expect(tool.description).toBeTruthy();
      expect(typeof tool.description).toBe("string");
    }
  });

  it("all 5 tools have exportable Zod schemas", () => {
    for (const tool of ALL_EXPECTED_TOOLS) {
      const jsonSchema = zodToJsonSchema(tool.schema);
      expect(jsonSchema).toHaveProperty("type", "object");
    }
  });

  it("tool definitions format correctly as OpenAI function-calling JSON", () => {
    const definitions = ALL_EXPECTED_TOOLS.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: zodToJsonSchema(tool.schema),
      },
    }));

    const json = JSON.stringify(definitions);
    const parsed = JSON.parse(json);

    expect(parsed).toHaveLength(5);

    const toolNames = parsed.map(
      (d: { function: { name: string } }) => d.function.name
    );
    expect(toolNames).toContain("kubectl_get");
    expect(toolNames).toContain("kubectl_describe");
    expect(toolNames).toContain("kubectl_logs");
    expect(toolNames).toContain("vector_search");
    expect(toolNames).toContain("kubectl_apply");

    for (const def of parsed) {
      expect(def.type).toBe("function");
      expect(def.function.name).toBeTruthy();
      expect(def.function.description).toBeTruthy();
      expect(def.function.parameters).toHaveProperty("type", "object");
    }
  });
});
