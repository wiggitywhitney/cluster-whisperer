/**
 * instance-storage.ts - Vector database storage for resource instances (PRD #26 M2)
 *
 * Takes resource instances from M1 (discovery) and stores them in the
 * vector database for semantic search. This enables the agent to answer
 * questions like "what databases are running?" by searching across all
 * resource instances in a single query.
 *
 * Two main functions:
 * - instanceToDocument(): Pure mapping from ResourceInstance to VectorDocument
 * - storeInstances(): Orchestrator that initializes the collection and stores all documents
 *
 * The embedding text is constructed as pipe-delimited sections:
 * Kind and name come first (primary identifiers), followed by namespace,
 * apiVersion, labels as key=value pairs, and description annotations.
 *
 * Metadata is stored as flat key-value pairs for exact-match filtering.
 * Labels are serialized as comma-separated "key=value" strings, consistent
 * with how capabilities store providers as comma-separated values.
 */

import { INSTANCES_COLLECTION } from "../vectorstore";
import type { VectorStore, VectorDocument } from "../vectorstore";
import type { ResourceInstance, StorageOptions } from "./types";

/**
 * Converts a ResourceInstance into a VectorDocument for storage.
 *
 * This is a pure function — no side effects, no async, fully testable.
 * The embedding text and metadata structure are the two critical design
 * decisions; see module docstring for rationale.
 *
 * @param instance - A resource instance from the M1 discovery pipeline
 * @returns A VectorDocument ready for vectorStore.store()
 */
export function instanceToDocument(instance: ResourceInstance): VectorDocument {
  return {
    id: instance.id,
    text: buildEmbeddingText(instance),
    metadata: buildMetadata(instance),
  };
}

/**
 * Stores resource instances in the vector database.
 *
 * Orchestrates the full storage flow:
 * 1. Initialize the instances collection (idempotent)
 * 2. Convert all instances to VectorDocuments
 * 3. Store them via the VectorStore interface
 *
 * The VectorStore is injected (not imported) so that:
 * - Unit tests use a mock (no Chroma server needed)
 * - Integration tests use a real ChromaBackend
 * - The code stays backend-agnostic
 *
 * @param instances - Array of ResourceInstance from M1
 * @param vectorStore - An initialized VectorStore instance
 * @param options - Optional progress callback
 */
export async function storeInstances(
  instances: ResourceInstance[],
  vectorStore: VectorStore,
  options?: StorageOptions
): Promise<void> {
  const onProgress = options?.onProgress ?? console.log; // eslint-disable-line no-console

  // Initialize the collection (idempotent — safe to call on every run)
  await vectorStore.initialize(INSTANCES_COLLECTION, {
    distanceMetric: "cosine",
  });

  if (instances.length === 0) {
    onProgress("No instances to store.");
    return;
  }

  // Convert all instances to vector documents
  onProgress(
    `Storing ${instances.length} resource instances in vector database...`
  );
  const documents = instances.map(instanceToDocument);

  // Store all documents (the backend handles batching and upsert)
  await vectorStore.store(INSTANCES_COLLECTION, documents);

  onProgress(
    `Storage complete: ${documents.length} instances stored in "${INSTANCES_COLLECTION}" collection.`
  );
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Builds the embedding text for an instance.
 *
 * The embedding text determines what semantic searches match. Structure:
 * 1. Kind and name — primary identifiers ("nginx deployment" matches)
 * 2. Namespace — so "default namespace" or "production" queries work
 * 3. apiVersion — so "apps/v1" queries work
 * 4. Labels — as key=value pairs for semantic matching
 * 5. Annotations — description annotations for semantic depth
 *
 * Sections are pipe-delimited for readability in search results.
 */
function buildEmbeddingText(instance: ResourceInstance): string {
  const parts: string[] = [];

  // Kind and name as the primary identifier
  parts.push(`${instance.kind} ${instance.name}`);

  // Namespace
  parts.push(`namespace: ${instance.namespace}`);

  // API version
  parts.push(`apiVersion: ${instance.apiVersion}`);

  // Labels as key=value pairs
  const labelEntries = Object.entries(instance.labels);
  if (labelEntries.length > 0) {
    const labelStr = labelEntries.map(([k, v]) => `${k}=${v}`).join(", ");
    parts.push(`labels: ${labelStr}`);
  }

  // Description annotations for semantic depth
  const annotationValues = Object.values(instance.annotations);
  if (annotationValues.length > 0) {
    parts.push(annotationValues.join(". "));
  }

  return parts.join(" | ");
}

/**
 * Builds flat metadata for exact-match filtering.
 *
 * Chroma metadata values must be string, number, or boolean — no nested objects.
 * Labels are stored as comma-separated "key=value" strings, consistent with
 * how capabilities store providers as comma-separated values.
 */
function buildMetadata(
  instance: ResourceInstance
): Record<string, string | number | boolean> {
  const labelEntries = Object.entries(instance.labels);
  const labelsStr =
    labelEntries.length > 0
      ? labelEntries.map(([k, v]) => `${k}=${v}`).join(",")
      : "";

  return {
    namespace: instance.namespace,
    name: instance.name,
    kind: instance.kind,
    apiVersion: instance.apiVersion,
    apiGroup: instance.apiGroup,
    labels: labelsStr,
    source: "resource-sync",
  };
}
