/**
 * vector-filter core - Structured metadata queries against the vector database
 *
 * What this file does:
 * Provides the core logic for filtering vector database documents by structured
 * metadata fields (kind, apiGroup, namespace). Unlike semantic search which
 * matches by meaning, this tool matches by exact values.
 *
 * When to use this vs vector_search:
 * - vector_search: "find resources related to databases" (semantic, fuzzy)
 * - vector_filter: "find all Deployments in the apps group" (exact, structured)
 *
 * The "semantic bridge" pattern:
 * These two tools work together. First use vector_search to discover what
 * resource types match a concept, then use vector_filter to find specific
 * instances of those types. Example:
 *   1. vector_search("managed database") → finds PostgreSQL, MySQL CRDs
 *   2. vector_filter(kind: "PostgreSQL") → finds running PostgreSQL instances
 */

import { z } from "zod";
import type { VectorStore, SearchOptions } from "../../vectorstore";
import { formatSearchResults } from "./format-results";

/**
 * Input schema for metadata-filtered vector queries.
 *
 * At least one filter field (kind, apiGroup, namespace) is required.
 * This prevents unbounded "list everything" queries — the LLM should
 * use semantic search for open-ended discovery.
 *
 * Fields:
 * - collection: Which collection to query
 * - kind: Kubernetes resource kind (e.g., "Deployment", "PostgreSQL")
 * - apiGroup: API group (e.g., "apps", "crossplane.io")
 * - namespace: Namespace filter (mainly useful for instances collection)
 * - query: Optional semantic query to combine with filters
 * - nResults: How many results to return (default: 10)
 */
export const vectorFilterSchema = z.object({
  collection: z
    .enum(["capabilities", "instances"])
    .describe(
      "Which collection to query: 'capabilities' for resource types, 'instances' for running resources"
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
  query: z
    .string()
    .optional()
    .describe(
      "Optional natural language query to combine with metadata filters for more targeted results"
    ),
  nResults: z
    .number()
    .optional()
    .describe("Maximum number of results to return (default: 10)"),
});

export type VectorFilterInput = z.infer<typeof vectorFilterSchema>;

/**
 * Tool description for LLMs.
 *
 * Explains the filter tool's purpose and how it complements semantic search.
 */
export const vectorFilterDescription = `Query the vector database by structured metadata filters (kind, apiGroup, namespace).

Use this tool when:
- You know the specific resource kind, API group, or namespace to look for
- You want to find all resources of a certain type (e.g., all Deployments)
- You're following up on semantic search results to find specific instances

At least one filter (kind, apiGroup, or namespace) is required.
You can optionally add a semantic query to rank filtered results by relevance.

Collections:
- "capabilities": Resource type descriptions. Filter by kind or apiGroup.
- "instances": Running resources. Filter by kind, apiGroup, or namespace.

For concept-based discovery ("find resources related to databases"), use vector_search instead.`;

/**
 * Execute a metadata-filtered query against the vector database.
 *
 * Builds a Chroma "where" filter from the structured inputs and optionally
 * combines it with a semantic query for ranked results.
 *
 * @param vectorStore - An initialized VectorStore instance
 * @param input - Validated input matching vectorFilterSchema
 * @returns Formatted search results as a string for LLM consumption
 */
export async function vectorFilter(
  vectorStore: VectorStore,
  input: VectorFilterInput
): Promise<string> {
  // Validate that at least one filter is provided.
  // This check lives here (not in Zod .refine()) because LangChain's tool()
  // requires a plain ZodObject schema — ZodEffects from .refine() isn't supported.
  if (!input.kind && !input.apiGroup && !input.namespace) {
    return "At least one filter (kind, apiGroup, or namespace) is required. For open-ended discovery, use vector_search instead.";
  }

  // Build the metadata filter from structured inputs
  const where = buildWhereFilter(input);

  // If a semantic query is provided, use it for ranking within the filtered set.
  // If not, use a generic query — Chroma requires a query for search().
  const query = input.query ?? "*";

  const searchOptions: SearchOptions = {
    nResults: input.nResults ?? 10,
    where,
  };

  const results = await vectorStore.search(
    input.collection,
    query,
    searchOptions
  );

  return formatSearchResults(results, input.collection);
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
  input: VectorFilterInput
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
