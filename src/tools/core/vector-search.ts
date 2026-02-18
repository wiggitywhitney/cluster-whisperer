/**
 * vector-search core - Unified search tool for the vector database
 *
 * What this file does:
 * Provides the single unified search tool that the agent uses to query the
 * vector database. It composes three search dimensions freely in one call:
 *
 * 1. Semantic search (query) — natural language → vector similarity via embeddings
 * 2. Keyword search (keyword) — substring matching via Chroma where_document, no embedding call
 * 3. Metadata filters (kind, apiGroup, namespace) — exact-match on structured fields
 *
 * Why one tool instead of separate tools?
 * Separate tools cause the LLM to make wasteful multi-call patterns (search then
 * filter separately). A single tool with composable dimensions makes it impossible
 * to use inefficiently and gives the LLM fewer tools to reason about.
 *
 * Smart backend method selection:
 * - Has `query` → collection.query() with embeddings (expensive, semantic ranking)
 * - Only `keyword`/filters → collection.get() with where_document/where (free, exact)
 * - Both `query` + `keyword` → collection.query() with embeddings + where_document
 *
 * This is the "semantic bridge" — it connects what a user is trying to do
 * (deploy a database) with what Kubernetes resources can do it (PostgreSQL CRD,
 * MySQL operator, etc.), even when the words differ.
 */

import { z } from "zod";
import type { VectorStore, SearchOptions } from "../../vectorstore";
import { formatSearchResults } from "./format-results";

/**
 * Input schema for the unified vector search tool.
 *
 * At least one of query, keyword, or a metadata filter (kind, apiGroup,
 * namespace) is required. All three dimensions compose freely — the tool
 * picks the optimal Chroma method internally.
 */
export const vectorSearchSchema = z.object({
  query: z
    .string()
    .optional()
    .describe(
      "Natural language description of what you're looking for (e.g., 'managed database', 'network traffic routing'). Uses semantic similarity — finds matches even when exact words differ. Costs an embedding API call."
    ),
  keyword: z
    .string()
    .optional()
    .describe(
      "Exact substring to match against document text (e.g., 'backup', 'PostgreSQL'). Fast and free — no embedding API call. Use this when you know the specific term to look for."
    ),
  collection: z
    .enum(["capabilities", "instances"])
    .describe(
      "Which collection to search: 'capabilities' for resource type descriptions (what CRDs and APIs can do), 'instances' for running resource metadata (what's deployed in the cluster)"
    ),
  kind: z
    .string()
    .optional()
    .describe(
      "Filter by Kubernetes resource kind (e.g., 'Deployment', 'Service', 'PostgreSQL')"
    ),
  apiGroup: z
    .string()
    .optional()
    .describe(
      "Filter by API group (e.g., 'apps', 'crossplane.io', 'acid.zalan.do')"
    ),
  namespace: z
    .string()
    .optional()
    .describe(
      "Filter by namespace (mainly useful for the 'instances' collection)"
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
 * Explains all three dimensions and when to use each one. The agent should
 * prefer this tool for discovery ("what can do X?") and kubectl tools
 * for investigation ("why is pod Y failing?").
 */
export const vectorSearchDescription = `Search the vector database to discover Kubernetes resources. Supports three composable search dimensions in a single call:

1. **Semantic search** (query): Natural language → finds conceptually similar resources even when exact words differ. Example: query "managed database" finds SQL CRDs. Costs an embedding API call.

2. **Keyword search** (keyword): Exact substring match on document text. Example: keyword "backup" finds docs mentioning "backup". Fast and free — no embedding call.

3. **Metadata filters** (kind, apiGroup, namespace): Exact match on structured fields. Example: kind "Deployment" finds only Deployments.

At least one dimension is required. All three compose freely:
- query alone → semantic discovery ("what resources handle databases?")
- keyword alone → exact text match ("find docs mentioning 'scaling'")
- kind/apiGroup/namespace alone → structured filtering ("all Deployments")
- query + kind → semantic search within a resource type
- keyword + apiGroup → substring match within an API group
- query + keyword + kind → all three combined

Collections:
- "capabilities": Resource type descriptions (CRDs, built-in types). Search here to find WHAT types exist.
- "instances": Running resource metadata. Search here to find WHAT is deployed.`;

/**
 * Execute a unified vector search against the vector database.
 *
 * This is the core logic — framework wrappers (LangChain, MCP) call this.
 * The VectorStore is injected so the function stays testable and
 * framework-agnostic.
 *
 * Smart dispatch:
 * - Has `query` → vectorStore.search() (embeddings, ranked by similarity)
 * - Only `keyword`/filters → vectorStore.keywordSearch() (no embeddings, free)
 * - Both → vectorStore.search() with whereDocument (embeddings + substring filter)
 *
 * @param vectorStore - An initialized VectorStore instance
 * @param input - Validated input matching vectorSearchSchema
 * @returns Formatted search results as a string for LLM consumption
 */
export async function vectorSearch(
  vectorStore: VectorStore,
  input: VectorSearchInput
): Promise<string> {
  // Validate that at least one search dimension is provided.
  // This check lives here (not in Zod .refine()) because LangChain's tool()
  // requires a plain ZodObject schema — ZodEffects from .refine() isn't supported.
  if (!input.query && !input.keyword && !input.kind && !input.apiGroup && !input.namespace) {
    return "At least one search dimension is required: query (semantic), keyword (substring), or a metadata filter (kind, apiGroup, namespace).";
  }

  // Build metadata filter from structured inputs
  const where = buildWhereFilter(input);

  // Build whereDocument from keyword input
  const whereDocument = input.keyword
    ? { $contains: input.keyword }
    : undefined;

  const searchOptions: SearchOptions = {
    nResults: input.nResults ?? 5,
    ...(where ? { where } : {}),
    ...(whereDocument ? { whereDocument } : {}),
  };

  // Smart dispatch: use semantic search if query is provided (expensive, ranked),
  // otherwise use keyword/filter search (free, unranked)
  if (input.query) {
    // Has semantic query → collection.query() with embeddings
    // If keyword is also provided, whereDocument narrows results before ranking
    const results = await vectorStore.search(
      input.collection,
      input.query,
      searchOptions
    );
    return formatSearchResults(results, input.collection);
  } else {
    // Only keyword and/or filters → collection.get() with no embedding call.
    // keyword may be undefined (filter-only case) — keywordSearch handles both.
    const results = await vectorStore.keywordSearch(
      input.collection,
      input.keyword,
      searchOptions
    );
    return formatSearchResults(results, input.collection);
  }
}

/**
 * Builds a Chroma-compatible "where" filter from structured input fields.
 *
 * Single filter: { kind: "Deployment" }
 * Multiple filters: { $and: [{ kind: "Deployment" }, { namespace: "default" }] }
 *
 * Chroma uses MongoDB-style query syntax. For a single condition, pass a plain
 * object. For multiple conditions, wrap them in $and.
 */
function buildWhereFilter(
  input: VectorSearchInput
): Record<string, unknown> | undefined {
  const conditions: Record<string, string>[] = [];

  if (input.kind) {
    conditions.push({ kind: input.kind });
  }
  if (input.apiGroup) {
    conditions.push({ apiGroup: input.apiGroup });
  }
  if (input.namespace) {
    conditions.push({ namespace: input.namespace });
  }

  if (conditions.length === 0) return undefined;
  if (conditions.length === 1) return conditions[0];
  return { $and: conditions };
}
