/**
 * storage.ts - Vector database storage for capability descriptions (M3)
 *
 * Takes capability descriptions from M2 (inference) and stores them in the
 * vector database for semantic search. This is the bridge between the
 * inference pipeline and the agent's search tools.
 *
 * Two main functions:
 * - capabilityToDocument(): Pure mapping from ResourceCapability to VectorDocument
 * - storeCapabilities(): Orchestrator that initializes the collection and stores all documents
 *
 * The embedding text is constructed to maximize semantic search quality:
 * Kind and group come first (so "Deployment" and "crossplane" match),
 * followed by capabilities as search terms, providers, description, and use case.
 *
 * Metadata is stored as flat key-value pairs for exact-match filtering.
 * The vector_search tool uses these to narrow results (e.g., kind:"SQL",
 * complexity:"low") before or alongside semantic ranking.
 */

import { CAPABILITIES_COLLECTION } from "../vectorstore";
import type { VectorStore, VectorDocument } from "../vectorstore";
import type { ResourceCapability, StorageOptions } from "./types";

/**
 * Converts a ResourceCapability into a VectorDocument for storage.
 *
 * This is a pure function — no side effects, no async, fully testable.
 * The embedding text and metadata structure are the two critical design
 * decisions; see module docstring for rationale.
 *
 * @param capability - A resource capability from the M2 inference pipeline
 * @returns A VectorDocument ready for vectorStore.store()
 */
export function capabilityToDocument(
  capability: ResourceCapability
): VectorDocument {
  return {
    id: capability.resourceName,
    text: buildEmbeddingText(capability),
    metadata: buildMetadata(capability),
  };
}

/**
 * Stores capability descriptions in the vector database.
 *
 * Orchestrates the full storage flow:
 * 1. Initialize the capabilities collection (idempotent)
 * 2. Convert all capabilities to VectorDocuments
 * 3. Store them via the VectorStore interface
 *
 * The VectorStore is injected (not imported) so that:
 * - Unit tests use a mock (no Chroma server needed)
 * - Integration tests use a real ChromaBackend
 * - The code stays backend-agnostic
 *
 * @param capabilities - Array of ResourceCapability from M2
 * @param vectorStore - An initialized VectorStore instance
 * @param options - Optional progress callback
 */
export async function storeCapabilities(
  capabilities: ResourceCapability[],
  vectorStore: VectorStore,
  options?: StorageOptions
): Promise<void> {
  const onProgress = options?.onProgress ?? console.log;

  // Initialize the collection (idempotent — safe to call on every run)
  await vectorStore.initialize(CAPABILITIES_COLLECTION, {
    distanceMetric: "cosine",
  });

  if (capabilities.length === 0) {
    onProgress("No capabilities to store.");
    return;
  }

  // Convert all capabilities to vector documents
  onProgress(
    `Storing ${capabilities.length} capability descriptions in vector database...`
  );
  const documents = capabilities.map(capabilityToDocument);

  // Store all documents (the backend handles batching and upsert)
  await vectorStore.store(CAPABILITIES_COLLECTION, documents);

  onProgress(
    `Storage complete: ${documents.length} capabilities stored in "${CAPABILITIES_COLLECTION}" collection.`
  );
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Builds the embedding text for a capability.
 *
 * The embedding text determines what semantic searches match. Structure:
 * 1. Kind and group — so "Deployment" or "crossplane" queries work
 * 2. Capabilities — the core semantic search terms
 * 3. Providers and complexity — so "AWS database" or "simple resources" match
 * 4. Description — natural language for semantic depth
 * 5. Use case — when/why a developer would use this
 *
 * Each section is on its own line for readability in search results.
 * The format-results.ts formatter displays this text to the agent.
 */
function buildEmbeddingText(capability: ResourceCapability): string {
  const lines: string[] = [];

  // Kind and group identifier
  const groupLabel = capability.group
    ? ` (${capability.group})`
    : "";
  lines.push(`${capability.kind}${groupLabel}`);

  // Capabilities as comma-separated search terms
  if (capability.capabilities.length > 0) {
    lines.push(`Capabilities: ${capability.capabilities.join(", ")}.`);
  }

  // Providers and complexity on one line
  const parts: string[] = [];
  if (capability.providers.length > 0) {
    parts.push(`Providers: ${capability.providers.join(", ")}`);
  }
  parts.push(`Complexity: ${capability.complexity}`);
  lines.push(parts.join(". ") + ".");

  // Description and use case
  lines.push(capability.description);
  lines.push(`Use case: ${capability.useCase}`);

  return lines.join("\n");
}

/**
 * Builds flat metadata for exact-match filtering.
 *
 * Chroma metadata values must be string, number, or boolean — no arrays.
 * Arrays (capabilities, providers) are stored as comma-separated strings.
 * The vector_search tool's buildWhereFilter() uses these for exact matching.
 */
function buildMetadata(
  capability: ResourceCapability
): Record<string, string | number | boolean> {
  return {
    kind: capability.kind,
    apiGroup: capability.group,
    apiVersion: capability.apiVersion,
    complexity: capability.complexity,
    providers: capability.providers.join(","),
    confidence: capability.confidence,
    resourceName: capability.resourceName,
  };
}
