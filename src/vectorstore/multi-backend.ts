// ABOUTME: VectorStore wrapper that delegates writes to multiple backends in parallel
// ABOUTME: Used during sync to populate both Chroma and Qdrant from a single pipeline run

/**
 * MultiBackendVectorStore — writes to many backends, reads from one.
 *
 * The "Choose Your Own Adventure" demo needs both Chroma and Qdrant populated
 * with the same capability and instance data. Running the LLM inference pipeline
 * twice (once per backend) wastes API costs. This wrapper lets a single sync
 * invocation populate both backends.
 *
 * How it works:
 * - Write operations (initialize, store, delete) run on ALL backends in parallel
 *   using Promise.all. If any backend fails, the whole operation rejects (fail-fast).
 * - Read operations (search, keywordSearch) run on the FIRST backend only.
 *   During sync, reads are only used for stale-document detection — the demo agent
 *   uses a single backend chosen by CLUSTER_WHISPERER_VECTOR_BACKEND.
 */

import type {
  VectorStore,
  VectorDocument,
  SearchResult,
  SearchOptions,
  CollectionOptions,
} from "./types";

export class MultiBackendVectorStore implements VectorStore {
  private readonly backends: VectorStore[];

  /**
   * Creates a MultiBackendVectorStore wrapping the given backends.
   *
   * @param backends - One or more VectorStore implementations to delegate to
   * @throws Error if the backends array is empty
   */
  constructor(backends: VectorStore[]) {
    if (backends.length === 0) {
      throw new Error("MultiBackendVectorStore requires at least one backend");
    }
    this.backends = backends;
  }

  /**
   * Initializes a collection on ALL backends in parallel.
   * Rejects if any backend fails (fail-fast via Promise.all).
   */
  async initialize(
    collection: string,
    options: CollectionOptions
  ): Promise<void> {
    await Promise.all(
      this.backends.map((b) => b.initialize(collection, options))
    );
  }

  /**
   * Stores documents in ALL backends in parallel.
   * Rejects if any backend fails (fail-fast via Promise.all).
   */
  async store(collection: string, documents: VectorDocument[]): Promise<void> {
    await Promise.all(
      this.backends.map((b) => b.store(collection, documents))
    );
  }

  /**
   * Deletes documents from ALL backends in parallel.
   * Rejects if any backend fails (fail-fast via Promise.all).
   */
  async delete(collection: string, ids: string[]): Promise<void> {
    await Promise.all(this.backends.map((b) => b.delete(collection, ids)));
  }

  /**
   * Searches the FIRST backend only.
   * During sync, reads are for stale detection — the demo agent reads from a
   * single backend chosen by the CLUSTER_WHISPERER_VECTOR_BACKEND env var.
   */
  async search(
    collection: string,
    query: string,
    options?: SearchOptions
  ): Promise<SearchResult[]> {
    return this.backends[0].search(collection, query, options);
  }

  /**
   * Keyword searches the FIRST backend only.
   * Same rationale as search() — reads go to one backend.
   */
  async keywordSearch(
    collection: string,
    keyword?: string,
    options?: SearchOptions
  ): Promise<SearchResult[]> {
    return this.backends[0].keywordSearch(collection, keyword, options);
  }
}
