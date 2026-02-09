/**
 * MCP tool registration for cluster-whisperer
 *
 * This module registers a single high-level "investigate" tool that wraps the
 * LangGraph agent. Instead of exposing low-level kubectl operations, MCP clients
 * get a complete investigation capability with full observability.
 *
 * Why a single investigate tool instead of kubectl_get, kubectl_describe, etc.?
 *
 * Trace quality:
 * - Old: Each kubectl tool call = separate trace. Fragmented observability.
 * - New: One investigate call = one trace containing all tool calls.
 *
 * The trace hierarchy shows the complete investigation:
 *   cluster-whisperer.mcp.investigate (root span)
 *   ├── anthropic.chat (LLM decides which tools to call)
 *   ├── kubectl_get.tool (internal tool call)
 *   ├── anthropic.chat (LLM processes result)
 *   ├── kubectl_describe.tool
 *   └── ... complete chain of reasoning and actions
 *
 * User experience:
 * MCP clients (like Claude Code) ask questions, not kubectl commands. Wrapping
 * our agent means users get the same experience in MCP mode as CLI mode - ask
 * a question, get a reasoned answer.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  invokeInvestigator,
  type InvestigationResult,
} from "../../agent/investigator";
import {
  withMcpRequestTracing,
  setTraceOutput,
} from "../../tracing/context-bridge";

/**
 * Zod schema for the investigate tool input.
 *
 * Single required parameter: the user's natural language question.
 * The agent handles all the complexity of figuring out which kubectl
 * commands to run, interpreting results, and synthesizing an answer.
 */
const investigateSchema = z.object({
  question: z
    .string()
    .describe(
      "Natural language question about the Kubernetes cluster to investigate"
    ),
});

type InvestigateInput = z.infer<typeof investigateSchema>;

/**
 * Description shown to MCP clients.
 *
 * This helps the client's LLM understand when to use this tool. Key points:
 * - It's an AI agent, not a simple kubectl wrapper
 * - It investigates and reasons, producing explanations
 * - It can handle multi-step investigations autonomously
 */
const investigateDescription = `Investigate a Kubernetes cluster using an AI agent.

This tool wraps a complete investigation agent that can:
- Query cluster resources (pods, deployments, services, nodes, etc.)
- Get detailed information about specific resources
- Read container logs for debugging
- Reason about what it finds and synthesize answers

The agent uses kubectl internally and can make multiple tool calls to fully
investigate a question. It returns a complete answer with explanation.

Example questions:
- "What pods are running in the default namespace?"
- "Find the broken pod and tell me why it's failing"
- "Is my nginx deployment healthy?"
- "What's causing the high restart count on pod X?"`;

/**
 * Registers the investigate tool with an MCP server.
 *
 * This is the only tool cluster-whisperer exposes to MCP clients. It wraps
 * the full LangGraph agent, providing complete investigations with proper
 * tracing hierarchy.
 *
 * @param server - The McpServer instance to register the tool with
 */
export function registerInvestigateTool(server: McpServer): void {
  server.registerTool(
    "investigate",
    {
      description: investigateDescription,
      inputSchema: investigateSchema.shape,
    },
    async (input: InvestigateInput) => {
      // Wrap entire investigation in MCP request tracing
      // This creates the root span that all agent activity nests under
      return withMcpRequestTracing(
        "investigate",
        input as Record<string, unknown>,
        async () => {
          // Invoke the investigator agent
          const result: InvestigationResult = await invokeInvestigator(
            input.question
          );

          // Build trace output: thinking + answer for observability
          // Full output goes to traceloop.entity.output; clean answer goes to
          // gen_ai.output.messages for Datadog LLM Observability CONTENT column
          const traceOutput = buildTraceOutput(result);
          setTraceOutput(traceOutput, result.answer);

          // Return MCP response with just the answer
          // Thinking is captured in traces, not returned to MCP client
          return {
            content: [{ type: "text" as const, text: result.answer }],
            isError: result.isError,
          };
        }
      );
    }
  );
}

/**
 * Builds the trace output string from an investigation result.
 *
 * Combines thinking blocks and answer into a single string for trace attributes.
 * This gives observability into the full investigation process.
 *
 * @param result - The investigation result from invokeInvestigator
 * @returns Formatted string with thinking and answer sections
 */
function buildTraceOutput(result: InvestigationResult): string {
  const parts: string[] = [];

  // Include thinking if present
  if (result.thinking.length > 0) {
    parts.push("=== Thinking ===");
    for (const thought of result.thinking) {
      parts.push(thought);
      parts.push("---");
    }
  }

  // Always include the answer
  parts.push("=== Answer ===");
  parts.push(result.answer);

  return parts.join("\n");
}
