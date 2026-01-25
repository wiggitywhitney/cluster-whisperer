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
} from "../core";

/**
 * kubectl_get tool for LangChain agents.
 * Lists Kubernetes resources in table format.
 */
export const kubectlGetTool = tool(
  async (input) => kubectlGet(input),
  {
    name: "kubectl_get",
    description: kubectlGetDescription,
    schema: kubectlGetSchema,
  }
);

/**
 * kubectl_describe tool for LangChain agents.
 * Gets detailed information about a specific resource.
 */
export const kubectlDescribeTool = tool(
  async (input) => kubectlDescribe(input),
  {
    name: "kubectl_describe",
    description: kubectlDescribeDescription,
    schema: kubectlDescribeSchema,
  }
);

/**
 * kubectl_logs tool for LangChain agents.
 * Gets container logs from a pod.
 */
export const kubectlLogsTool = tool(
  async (input) => kubectlLogs(input),
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
