/**
 * format-results.ts - Formats vector search results for LLM consumption
 *
 * What this file does:
 * Converts raw SearchResult arrays from the vector database into readable
 * text that the LLM can understand and reason about. Both the semantic search
 * and filter query tools use this same formatter.
 *
 * Why a shared formatter?
 * Both vector tools return the same SearchResult type. Formatting once keeps
 * the output consistent and avoids duplicating the presentation logic.
 *
 * Design choices:
 * - Plain text, not JSON — LLMs read prose better than structured data
 * - Score included with explanation — so the LLM understands relevance
 * - Metadata on a separate line — easy to scan for kind, apiGroup, etc.
 * - Numbered results — helps the LLM reference specific items
 */

import type { SearchResult } from "../../vectorstore";

/**
 * Formats an array of search results into LLM-readable text.
 *
 * Example output:
 *   Found 3 results in "capabilities" collection:
 *
 *   1. apps/v1/Deployment (distance: 0.15 — very similar)
 *      Manages replicated application pods with rolling updates...
 *      Metadata: kind=Deployment, apiGroup=apps, version=v1
 *
 *   2. acid.zalan.do/v1/postgresql (distance: 0.32 — similar)
 *      ...
 *
 * @param results - Search results from VectorStore.search()
 * @param collection - Which collection was searched (for the header)
 * @returns Formatted string for the LLM to read
 */
export function formatSearchResults(
  results: SearchResult[],
  collection: string
): string {
  if (results.length === 0) {
    return `No results found in "${collection}" collection.`;
  }

  const header = `Found ${results.length} result${results.length === 1 ? "" : "s"} in "${collection}" collection:\n`;

  const formatted = results.map((result, index) => {
    const similarity = describeSimilarity(result.score);
    const metadataLine = formatMetadata(result.metadata);

    const lines = [
      `${index + 1}. ${result.id} (distance: ${result.score.toFixed(2)} — ${similarity})`,
      `   ${result.text}`,
    ];

    if (metadataLine) {
      lines.push(`   Metadata: ${metadataLine}`);
    }

    return lines.join("\n");
  });

  return header + "\n" + formatted.join("\n\n");
}

/**
 * Converts a cosine distance score into a human-readable similarity label.
 *
 * Cosine distance ranges:
 * - 0.0 = identical vectors (perfect match)
 * - 0.0–0.3 = very similar (strong semantic match)
 * - 0.3–0.6 = similar (related content)
 * - 0.6–1.0 = somewhat related (weak match)
 * - 1.0–2.0 = dissimilar to opposite
 */
function describeSimilarity(score: number): string {
  if (score < 0.3) return "very similar";
  if (score < 0.6) return "similar";
  if (score < 1.0) return "somewhat related";
  return "weak match";
}

/**
 * Formats metadata key-value pairs into a readable string.
 *
 * Skips empty metadata. Joins pairs with commas.
 * Example: "kind=Deployment, apiGroup=apps, version=v1"
 */
function formatMetadata(
  metadata: Record<string, string | number | boolean>
): string {
  const entries = Object.entries(metadata);
  if (entries.length === 0) return "";
  return entries.map(([key, value]) => `${key}=${value}`).join(", ");
}
