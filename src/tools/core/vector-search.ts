/**
 * vector-search core - Semantic search over the vector database
 *
 * What this file does:
 * Provides the core logic for natural language search against the vector
 * database. The agent uses this tool when it needs to discover Kubernetes
 * resources by concept — "find resources related to databases" — rather
 * than by exact name.
 *
 * How it works:
 * 1. The LLM calls this tool with a natural language query
 * 2. The query text gets embedded into a vector (via VoyageEmbedding)
 * 3. The vector is compared against all stored document vectors
 * 4. The closest matches are returned, ranked by similarity
 *
 * This is the "semantic bridge" — it connects what a user is trying to
 * do (deploy a database) with what Kubernetes resources can do it
 * (PostgreSQL CRD, MySQL operator, etc.), even when the words differ.
 */

import { z } from "zod";
import type { VectorStore } from "../../vectorstore";
import { formatSearchResults } from "./format-results";

/**
 * Input schema for semantic vector search.
 *
 * Fields:
 * - query: Natural language description of what the user is looking for.
 *   This gets embedded and compared against stored document vectors.
 * - collection: Which collection to search. "capabilities" has resource type
 *   descriptions; "instances" has running resource metadata.
 * - nResults: How many results to return. Default 5 keeps output manageable
 *   for the LLM while providing enough options.
 */
export const vectorSearchSchema = z.object({
  query: z
    .string()
    .describe(
      "Natural language description of what you're looking for (e.g., 'managed database', 'network traffic routing', 'container orchestration')"
    ),
  collection: z
    .enum(["capabilities", "instances"])
    .describe(
      "Which collection to search: 'capabilities' for resource type descriptions (what CRDs and APIs can do), 'instances' for running resource metadata (what's deployed in the cluster)"
    ),
  nResults: z
    .number()
    .optional()
    .describe("Maximum number of results to return (default: 5)"),
});

export type VectorSearchInput = z.infer<typeof vectorSearchSchema>;

/**
 * Tool description for LLMs.
 *
 * Explains when to use semantic search vs other tools. The agent should
 * prefer this tool for discovery ("what can do X?") and kubectl tools
 * for investigation ("why is pod Y failing?").
 */
export const vectorSearchDescription = `Search the vector database using natural language to discover Kubernetes resources by concept.

Use this tool when:
- You need to find what resource types can accomplish a task ("managed database", "ingress routing")
- You want to discover CRDs or APIs related to a concept, even if you don't know the exact names
- You're looking for running resources that match a description

This performs semantic similarity search — it finds resources whose descriptions are
conceptually similar to your query, even if the exact words differ.

Collections:
- "capabilities": Resource type descriptions (CRDs, built-in types). Search here first to find WHAT types exist.
- "instances": Running resource metadata. Search here to find WHAT is deployed.

Results include a distance score (0.0 = identical, lower = more similar).

If you need BOTH semantic search AND metadata filtering (e.g., "find database resources
that are CRDs"), use vector_filter with its optional query parameter — it combines both
in a single efficient call. Do NOT call vector_search then vector_filter separately.`;

/**
 * Execute a semantic search against the vector database.
 *
 * This is the core logic — framework wrappers (LangChain, MCP) call this.
 * The VectorStore is injected so the function stays testable and
 * framework-agnostic.
 *
 * @param vectorStore - An initialized VectorStore instance
 * @param input - Validated input matching vectorSearchSchema
 * @returns Formatted search results as a string for LLM consumption
 */
export async function vectorSearch(
  vectorStore: VectorStore,
  input: VectorSearchInput
): Promise<string> {
  const results = await vectorStore.search(input.collection, input.query, {
    nResults: input.nResults ?? 5,
  });

  return formatSearchResults(results, input.collection);
}
