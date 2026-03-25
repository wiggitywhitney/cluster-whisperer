// ABOUTME: Vercel AI SDK tool wrappers for kubectl, vector search, and apply operations
// ABOUTME: Wraps core functions with AI SDK 6's tool() helper for Vercel agent use

/**
 * Vercel AI SDK tool wrappers for kubectl and vector search operations
 *
 * This module wraps the core functions with the Vercel AI SDK's tool() helper.
 * The Vercel agent imports from here to get tools for use with streamText().
 *
 * Why separate wrappers?
 * The core logic (schemas, execution functions) lives in ../core/. This module
 * adds the Vercel AI SDK-specific wrapper that makes them usable by the Vercel
 * agent. The LangChain agent has its own wrappers in ../langchain/ using the
 * same core. Both produce identical investigation experiences.
 *
 * Key difference from LangChain wrappers:
 * - Uses AI SDK 6's tool() from 'ai' (not @langchain/core/tools)
 * - Uses inputSchema (not schema/parameters) — this is the SDK 6 convention
 * - Returns Record<string, Tool> (not arrays) — streamText requires this format
 * - Tool names are object keys (not a name property on each tool)
 *
 * OpenTelemetry tracing:
 * Each tool is wrapped with withToolTracing() to create spans with identical
 * names and attributes regardless of which agent framework calls them. This
 * ensures the shared telemetry contract (cluster_whisperer.* attributes) holds.
 * The Vercel SDK also creates its own ai.toolCall spans — both coexist
 * intentionally (documented in M2 Weaver schema).
 */

import { tool } from "ai";
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
  type KubectlOptions,
} from "../core";
import { withToolTracing } from "../../tracing/tool-tracing";
import { truncateToolResult } from "../../utils/truncate";
import type { VectorStore } from "../../vectorstore";
import {
  CAPABILITIES_COLLECTION,
  INSTANCES_COLLECTION,
} from "../../vectorstore";

/**
 * Creates kubectl read tools (get, describe, logs) for the Vercel AI SDK agent.
 *
 * Why a factory function instead of static exports?
 * The kubeconfig option needs to be captured at tool creation time via closure.
 * When CLUSTER_WHISPERER_KUBECONFIG is set, every kubectl call needs --kubeconfig
 * prepended — the factory captures this path once and all tool invocations use it.
 *
 * @param options - Optional kubectl configuration (e.g., kubeconfig path)
 * @returns Record<string, Tool> with kubectl_get, kubectl_describe, kubectl_logs
 */
export function createKubectlTools(options?: KubectlOptions) {
  return {
    kubectl_get: tool({
      description: kubectlGetDescription,
      inputSchema: kubectlGetSchema,
      execute: withToolTracing(
        { name: "kubectl_get", description: kubectlGetDescription },
        async (input: KubectlGetInput) => {
          const { output } = await kubectlGet(input, options);
          return truncateToolResult(output);
        }
      ),
    }),

    kubectl_describe: tool({
      description: kubectlDescribeDescription,
      inputSchema: kubectlDescribeSchema,
      execute: withToolTracing(
        { name: "kubectl_describe", description: kubectlDescribeDescription },
        async (input: KubectlDescribeInput) => {
          const { output } = await kubectlDescribe(input, options);
          return truncateToolResult(output);
        }
      ),
    }),

    kubectl_logs: tool({
      description: kubectlLogsDescription,
      inputSchema: kubectlLogsSchema,
      execute: withToolTracing(
        { name: "kubectl_logs", description: kubectlLogsDescription },
        async (input: KubectlLogsInput) => {
          const { output } = await kubectlLogs(input, options);
          return truncateToolResult(output);
        }
      ),
    }),
  };
}

/**
 * Creates the unified vector search tool bound to a VectorStore instance.
 *
 * Why a factory function?
 * The vector tool needs a shared, initialized VectorStore — unlike kubectl tools
 * which are stateless. This factory creates a tool that closes over the store
 * and lazily initializes collections on first use.
 *
 * Lazy initialization means:
 * - The vector database doesn't need to be running at agent startup
 * - Collections are initialized once, then cached
 * - If the vector database is unreachable, the tool returns a helpful error
 *   message instead of crashing the agent
 *
 * @param vectorStore - A VectorStore instance (e.g., new ChromaBackend(embedder))
 * @returns Record<string, Tool> with vector_search
 */
export function createVectorTools(vectorStore: VectorStore) {
  let initialized = false;

  /**
   * Initializes both collections on first use.
   * After the first successful call, it's a no-op. If the vector database
   * is unreachable, this throws and the wrapper catches it.
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
   * Connection errors return a helpful message; other errors pass through.
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

        if (
          message.includes("ECONNREFUSED") ||
          message.includes("fetch failed") ||
          message.includes("ENOTFOUND") ||
          message.includes("ETIMEDOUT") ||
          message.includes("ECONNRESET")
        ) {
          return (
            "Vector database is not available. The vector database server may not be running. " +
            "Use kubectl tools to investigate the cluster directly."
          );
        }

        throw error;
      }
    };
  }

  return {
    vector_search: tool({
      description: vectorSearchDescription,
      inputSchema: vectorSearchSchema,
      execute: withToolTracing(
        { name: "vector_search", description: vectorSearchDescription },
        withGracefulDegradation(async (input: VectorSearchInput) => {
          return vectorSearch(vectorStore, input);
        })
      ),
    }),
  };
}

/**
 * Creates the kubectl_apply tool bound to a VectorStore instance.
 *
 * Why a factory function?
 * Like the vector search tool, kubectl_apply needs a VectorStore for catalog
 * validation. The core kubectlApply function checks whether the resource type
 * exists in the capabilities collection before allowing the apply.
 *
 * Graceful degradation:
 * If the vector database is unreachable, the tool returns a helpful error
 * message instead of crashing. Without catalog validation, apply is blocked
 * (fail-closed, not fail-open).
 *
 * @param vectorStore - A VectorStore instance for catalog validation
 * @param options - Optional kubectl configuration (e.g., kubeconfig path)
 * @returns Record<string, Tool> with kubectl_apply
 */
export function createApplyTools(
  vectorStore: VectorStore,
  options?: KubectlOptions
) {
  let initialized = false;

  /**
   * Initializes the capabilities collection on first use.
   * kubectl_apply needs the capabilities collection for catalog validation.
   */
  async function ensureInitialized(): Promise<void> {
    if (initialized) return;
    await vectorStore.initialize(CAPABILITIES_COLLECTION, {
      distanceMetric: "cosine",
    });
    initialized = true;
  }

  /**
   * Wraps the apply tool handler with initialization and connection error handling.
   * Connection errors get a user-friendly message; other errors pass through
   * from the core function (catalog rejections, parse failures, etc.).
   */
  function withGracefulDegradation(
    handler: (input: KubectlApplyInput) => Promise<string>
  ): (input: KubectlApplyInput) => Promise<string> {
    return async (input: KubectlApplyInput): Promise<string> => {
      try {
        await ensureInitialized();
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

        throw error;
      }
    };
  }

  return {
    kubectl_apply: tool({
      description: kubectlApplyDescription,
      inputSchema: kubectlApplySchema,
      execute: withToolTracing(
        { name: "kubectl_apply", description: kubectlApplyDescription },
        withGracefulDegradation(async (input: KubectlApplyInput) => {
          const { output } = await kubectlApply(vectorStore, input, {
            kubeconfig: options?.kubeconfig,
          });
          return output;
        })
      ),
    }),
  };
}
