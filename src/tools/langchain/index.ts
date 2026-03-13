// ABOUTME: LangChain tool wrappers for kubectl, vector search, and apply operations
// ABOUTME: Wraps core functions with LangChain's tool() helper for agent use

/**
 * LangChain tool wrappers for kubectl and vector search operations
 *
 * This module wraps the core functions with LangChain's tool() helper.
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
 *
 * Vector tool lifecycle:
 * Unlike kubectl tools (stateless, each spawns a subprocess), the vector tool
 * needs a shared VectorStore instance. The createVectorTools() factory creates
 * a tool that closes over the VectorStore and lazily initializes collections
 * on first use. This means Chroma doesn't need to be running until the agent
 * actually needs vector search.
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
  vectorSearch,
  vectorSearchSchema,
  vectorSearchDescription,
  kubectlApply,
  kubectlApplySchema,
  kubectlApplyDescription,
  type KubectlGetInput,
  type KubectlDescribeInput,
  type KubectlLogsInput,
  type VectorSearchInput,
  type KubectlApplyInput,
} from "../core";
import { withToolTracing } from "../../tracing/tool-tracing";
import type { VectorStore } from "../../vectorstore";
import {
  CAPABILITIES_COLLECTION,
  INSTANCES_COLLECTION,
} from "../../vectorstore";

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
  withToolTracing(
    { name: "kubectl_get", description: kubectlGetDescription },
    async (input: KubectlGetInput) => {
      const { output } = await kubectlGet(input);
      return output;
    }
  ),
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
  withToolTracing(
    { name: "kubectl_describe", description: kubectlDescribeDescription },
    async (input: KubectlDescribeInput) => {
      const { output } = await kubectlDescribe(input);
      return output;
    }
  ),
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
  withToolTracing(
    { name: "kubectl_logs", description: kubectlLogsDescription },
    async (input: KubectlLogsInput) => {
      const { output } = await kubectlLogs(input);
      return output;
    }
  ),
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

/**
 * Creates the unified vector search tool bound to a VectorStore instance.
 *
 * Why a factory function?
 * The vector tool needs a shared, initialized VectorStore — unlike kubectl tools
 * which are stateless. This factory creates a tool that closes over the store
 * and lazily initializes collections on first use.
 *
 * Lazy initialization means:
 * - Chroma doesn't need to be running at agent startup
 * - Collections are initialized once, then cached
 * - If Chroma is unreachable, the tool returns a helpful error message
 *   instead of crashing the agent
 *
 * @param vectorStore - A VectorStore instance (e.g., new ChromaBackend(embedder))
 * @returns Array containing the single unified vector_search tool
 */
export function createVectorTools(vectorStore: VectorStore) {
  let initialized = false;

  /**
   * Initializes both collections on first use.
   *
   * Called before every vector tool invocation. After the first successful
   * call, it's a no-op (the flag prevents re-initialization). If Chroma
   * is unreachable, this throws and the tool wrapper catches it.
   */
  async function ensureInitialized(): Promise<void> {
    if (initialized) return;
    await vectorStore.initialize(CAPABILITIES_COLLECTION, {
      distanceMetric: "cosine",
    });
    await vectorStore.initialize(INSTANCES_COLLECTION, {
      distanceMetric: "cosine",
    });
    initialized = true;
  }

  /**
   * Wraps a vector tool handler with initialization and error handling.
   *
   * If Chroma is unreachable, returns a helpful message instead of crashing.
   * The agent can then fall back to kubectl tools for investigation.
   */
  function withGracefulDegradation<T>(
    handler: (input: T) => Promise<string>
  ): (input: T) => Promise<string> {
    return async (input: T): Promise<string> => {
      try {
        await ensureInitialized();
        return await handler(input);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error);

        // Connection errors indicate Chroma isn't running
        if (
          message.includes("ECONNREFUSED") ||
          message.includes("fetch failed") ||
          message.includes("ENOTFOUND") ||
          message.includes("ETIMEDOUT") ||
          message.includes("ECONNRESET")
        ) {
          return (
            "Vector database is not available. The Chroma server may not be running. " +
            "Use kubectl tools to investigate the cluster directly."
          );
        }

        // Other errors (bad query, etc.) — let the LLM see the error
        return `Vector search failed: ${message}`;
      }
    };
  }

  const vectorSearchTool = tool(
    withToolTracing(
      { name: "vector_search", description: vectorSearchDescription },
      withGracefulDegradation(async (input: VectorSearchInput) => {
        return vectorSearch(vectorStore, input);
      })
    ),
    {
      name: "vector_search",
      description: vectorSearchDescription,
      schema: vectorSearchSchema,
    }
  );

  return [vectorSearchTool];
}

/**
 * Creates the kubectl_apply tool bound to a VectorStore instance.
 *
 * Why a factory function?
 * Like the vector search tool, kubectl_apply needs a VectorStore for catalog
 * validation. The core kubectlApply function checks whether the resource type
 * exists in the capabilities collection before allowing the apply. This factory
 * creates a tool that closes over the VectorStore instance.
 *
 * Graceful degradation:
 * If the vector database is unreachable, the tool returns a helpful error
 * message instead of crashing. Without catalog validation, apply is blocked
 * (fail-closed, not fail-open).
 *
 * @param vectorStore - A VectorStore instance for catalog validation
 * @returns Array containing the single kubectl_apply tool
 */
export function createApplyTools(vectorStore: VectorStore) {
  /**
   * Wraps the apply tool handler with connection error handling.
   *
   * Connection errors (ECONNREFUSED, etc.) get a user-friendly message.
   * Other errors (parse failures, catalog rejections) pass through from
   * the core function since they're already well-formatted.
   */
  function withGracefulDegradation(
    handler: (input: KubectlApplyInput) => Promise<string>
  ): (input: KubectlApplyInput) => Promise<string> {
    return async (input: KubectlApplyInput): Promise<string> => {
      try {
        return await handler(input);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error);

        if (
          message.includes("ECONNREFUSED") ||
          message.includes("fetch failed") ||
          message.includes("ENOTFOUND") ||
          message.includes("ETIMEDOUT") ||
          message.includes("ECONNRESET")
        ) {
          return (
            "Vector database is not available. Cannot validate resource against the platform catalog. " +
            "The catalog database must be running for kubectl_apply to work."
          );
        }

        return `kubectl apply failed: ${message}`;
      }
    };
  }

  const kubectlApplyTool = tool(
    withToolTracing(
      { name: "kubectl_apply", description: kubectlApplyDescription },
      withGracefulDegradation(async (input: KubectlApplyInput) => {
        const { output } = await kubectlApply(vectorStore, input);
        return output;
      })
    ),
    {
      name: "kubectl_apply",
      description: kubectlApplyDescription,
      schema: kubectlApplySchema,
    }
  );

  return [kubectlApplyTool];
}
