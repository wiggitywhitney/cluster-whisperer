/**
 * LangChain tool wrappers for kubectl operations
 *
 * This module wraps the core kubectl functions with LangChain's tool() helper.
 * The CLI agent imports from here to get tools it can use in the agentic loop.
 *
 * Why separate wrappers?
 * The core logic (schemas, execution functions) lives in ../core/. This module
 * adds the LangChain-specific wrapper that makes them usable by LangChain agents.
 * The MCP server has its own wrappers in ../mcp/ using the same core.
 *
 * What does tool() do?
 * LangChain's tool() function takes an async function and options (name,
 * description, schema) and returns a Tool object. The agent reads the
 * description to decide when to use it, and LangChain handles validation.
 *
 * OpenTelemetry tracing:
 * Each tool is wrapped with withToolTracing() to create parent spans for
 * observability. This creates the hierarchy: execute_tool kubectl_get → kubectl get pods
 */

import { tool } from "@langchain/core/tools";
import {
  kubectlGet,
  kubectlGetSchema,
  kubectlGetDescription,
  kubectlDescribe,
  kubectlDescribeSchema,
  kubectlDescribeDescription,
  kubectlLogs,
  kubectlLogsSchema,
  kubectlLogsDescription,
  type KubectlGetInput,
  type KubectlDescribeInput,
  type KubectlLogsInput,
} from "../core";
import { withToolTracing } from "../../tracing/tool-tracing";

/**
 * kubectl_get tool for LangChain agents.
 * Lists Kubernetes resources in table format.
 *
 * Note: Core functions return { output, isError }. LangChain tools expect
 * a string, so we extract just the output. The isError flag is only used
 * by MCP clients; LangChain agents interpret the error message content.
 *
 * Wrapped with withToolTracing() to create parent spans for kubectl subprocess spans.
 */
export const kubectlGetTool = tool(
  withToolTracing("kubectl_get", async (input: KubectlGetInput) => {
    const { output } = await kubectlGet(input);
    return output;
  }),
  {
    name: "kubectl_get",
    description: kubectlGetDescription,
    schema: kubectlGetSchema,
  }
);

/**
 * kubectl_describe tool for LangChain agents.
 * Gets detailed information about a specific resource.
 *
 * Wrapped with withToolTracing() to create parent spans for kubectl subprocess spans.
 */
export const kubectlDescribeTool = tool(
  withToolTracing("kubectl_describe", async (input: KubectlDescribeInput) => {
    const { output } = await kubectlDescribe(input);
    return output;
  }),
  {
    name: "kubectl_describe",
    description: kubectlDescribeDescription,
    schema: kubectlDescribeSchema,
  }
);

/**
 * kubectl_logs tool for LangChain agents.
 * Gets container logs from a pod.
 *
 * Wrapped with withToolTracing() to create parent spans for kubectl subprocess spans.
 */
export const kubectlLogsTool = tool(
  withToolTracing("kubectl_logs", async (input: KubectlLogsInput) => {
    const { output } = await kubectlLogs(input);
    return output;
  }),
  {
    name: "kubectl_logs",
    description: kubectlLogsDescription,
    schema: kubectlLogsSchema,
  }
);

/**
 * All kubectl tools for the LangChain agent.
 * Import this array to give the agent access to all investigation tools.
 */
export const kubectlTools = [kubectlGetTool, kubectlDescribeTool, kubectlLogsTool];
