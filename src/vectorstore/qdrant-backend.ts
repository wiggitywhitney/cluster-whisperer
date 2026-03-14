// ABOUTME: Qdrant implementation of the VectorStore interface with OTel span instrumentation
// ABOUTME: Wraps all Qdrant operations in spans with DB semconv attributes for observability
/**
 * qdrant-backend.ts - Qdrant implementation of the VectorStore interface
 *
 * What this file does:
 * Implements the VectorStore interface using Qdrant as the backend. This is the
 * only file in the project that imports from "@qdrant/js-client-rest" — everything
 * else codes against the VectorStore interface in types.ts.
 *
 * Why a second backend?
 * The KubeCon demo shows both Chroma and Qdrant as vector database options.
 * The --vector-backend flag (M6) switches between them at runtime. Both backends
 * implement the same VectorStore interface, so the pipelines and tools work
 * with either one without changes.
 *
 * How it works:
 * 1. initialize() creates a Qdrant collection with the right distance metric
 * 2. store() embeds document text via our EmbeddingFunction, then upserts
 *    points with vectors + payloads into Qdrant
 * 3. search() embeds the query, runs vector similarity via client.query()
 * 4. keywordSearch() uses client.scroll() with payload filters (no vectors)
 * 5. delete() removes points by ID
 *
 * Filter translation:
 * The VectorStore interface uses Chroma-style flat key-value filters
 * (e.g., { kind: "Deployment" }). This backend translates them to Qdrant's
 * must/should/must_not format internally, keeping the interface backend-agnostic.
 */

import { createHash } from "node:crypto";
import { QdrantClient } from "@qdrant/js-client-rest";
import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import { getTracer } from "../tracing";
import type {
  VectorStore,
  VectorDocument,
  SearchResult,
  CollectionOptions,
  SearchOptions,
  EmbeddingFunction,
} from "./types";

/**
 * Default Qdrant server URL.
 *
 * Qdrant's REST API listens on port 6333 by default.
 * Override with the QDRANT_URL environment variable.
 */
const DEFAULT_QDRANT_URL = "http://localhost:6333";

/**
 * Maximum documents per embed+upsert batch.
 *
 * Keeps each Voyage AI embed() call and Qdrant upsert() within API limits.
 * Matches ChromaBackend's batch size for consistency.
 */
const UPSERT_BATCH_SIZE = 100;

/**
 * Maps VectorStore distance metric names to Qdrant's distance enum values.
 *
 * VectorStore uses lowercase names from the interface ("cosine", "l2", "ip").
 * Qdrant uses capitalized names ("Cosine", "Euclid", "Dot").
 */
const DISTANCE_METRIC_MAP: Record<string, string> = {
  cosine: "Cosine",
  l2: "Euclid",
  ip: "Dot",
};

/**
 * UUID v5 namespace (DNS namespace from RFC 4122).
 * Used to deterministically convert string document IDs to UUIDs.
 * Qdrant only accepts unsigned integers or UUIDs as point IDs.
 */
const UUID_V5_NAMESPACE = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";

/**
 * Converts a string ID to a deterministic UUID v5.
 *
 * Qdrant rejects arbitrary string point IDs — it requires unsigned integers
 * or UUIDs. This function hashes the string ID with SHA-1 (per UUID v5 spec)
 * to produce a stable UUID. The same input always produces the same UUID,
 * preserving upsert semantics.
 *
 * The original string ID is stored in the payload as `_originalId` so it can
 * be recovered on read operations (search, keywordSearch).
 */
export function stringToUuidV5(name: string): string {
  const namespaceBytes = Buffer.from(
    UUID_V5_NAMESPACE.replace(/-/g, ""),
    "hex"
  );
  const hash = createHash("sha1").update(namespaceBytes).update(name).digest();

  // Set version (5) and variant (10xx) bits per RFC 4122
  hash[6] = (hash[6] & 0x0f) | 0x50;
  hash[8] = (hash[8] & 0x3f) | 0x80;

  const hex = hash.toString("hex").substring(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Payload key for storing the original string document ID.
 * Used to recover the human-readable ID from search/keywordSearch results.
 */
const ORIGINAL_ID_KEY = "_originalId";

/**
 * Qdrant implementation of the VectorStore interface.
 *
 * Usage:
 *   const embedder = new VoyageEmbedding();
 *   const store = new QdrantBackend(embedder, { vectorSize: 1024 });
 *
 *   await store.initialize("capabilities", { distanceMetric: "cosine" });
 *   await store.store("capabilities", [{ id: "...", text: "...", metadata: {} }]);
 *   const results = await store.search("capabilities", "managed database");
 */
export class QdrantBackend implements VectorStore {
  private readonly client: QdrantClient;
  private readonly embedder: EmbeddingFunction;
  private readonly vectorSize: number;

  /**
   * Set of initialized collection names.
   *
   * Unlike Chroma, Qdrant doesn't return a collection handle. We track
   * which collections have been initialized to provide the same "call
   * initialize() first" guard as ChromaBackend.
   */
  private readonly initializedCollections: Set<string> = new Set();

  /**
   * Creates a new Qdrant backend.
   *
   * @param embedder - The embedding function for converting text to vectors.
   * @param options - Configuration options
   * @param options.qdrantUrl - Qdrant server URL. Defaults to QDRANT_URL env var
   *                           or http://localhost:6333.
   * @param options.vectorSize - Dimensionality of embedding vectors. Required because
   *                            Qdrant needs the vector size at collection creation time.
   *                            Voyage AI voyage-4 produces 1024-dimensional vectors.
   */
  constructor(
    embedder: EmbeddingFunction,
    options?: { qdrantUrl?: string; vectorSize?: number }
  ) {
    this.embedder = embedder;
    this.vectorSize = options?.vectorSize ?? 1024;

    const url =
      options?.qdrantUrl ?? process.env.CLUSTER_WHISPERER_QDRANT_URL ?? process.env.QDRANT_URL ?? DEFAULT_QDRANT_URL;
    const parsed = new URL(url);

    // When a port is explicit in the URL (e.g., http://localhost:6333), use it.
    // When no port is specified (e.g., http://qdrant.nip.io via ingress),
    // fall back to the protocol default (80/443) — not the Qdrant default (6333).
    const port = parsed.port
      ? parseInt(parsed.port, 10)
      : parsed.protocol === "https:" ? 443 : 80;

    this.client = new QdrantClient({
      host: parsed.hostname,
      port,
    });
  }

  /**
   * Creates a collection if it doesn't exist.
   *
   * Unlike Chroma's getOrCreateCollection, Qdrant requires checking existence
   * first, then creating if needed. The distance metric and vector size are
   * set at creation time and cannot be changed later.
   */
  async initialize(
    collection: string,
    options: CollectionOptions
  ): Promise<void> {
    const tracer = getTracer();
    return tracer.startActiveSpan(
      "cluster-whisperer.vectorstore.initialize",
      { kind: SpanKind.CLIENT },
      async (span) => {
        span.setAttribute("db.system", "qdrant");
        span.setAttribute("db.operation.name", "create_collection");
        span.setAttribute("db.collection.name", collection);

        try {
          const { exists } = await this.client.collectionExists(collection);

          if (!exists) {
            const distance =
              DISTANCE_METRIC_MAP[options.distanceMetric] ?? "Cosine";

            await this.client.createCollection(collection, {
              vectors: {
                size: this.vectorSize,
                distance: distance as "Cosine" | "Euclid" | "Dot",
              },
            });
          }

          this.initializedCollections.add(collection);
          span.setStatus({ code: SpanStatusCode.OK });
        } catch (error) {
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: error instanceof Error ? error.message : String(error),
          });
          span.recordException(error as Error);
          throw error;
        } finally {
          span.end();
        }
      }
    );
  }

  /**
   * Stores documents in a Qdrant collection.
   *
   * Each document's text is embedded automatically and stored as a point
   * with the vector and a payload containing the document text and metadata.
   * Uses upsert semantics — existing points with the same ID are updated.
   *
   * Qdrant payload structure:
   * - "document": the original text (used for keyword search and retrieval)
   * - All metadata fields are spread into the payload as top-level keys
   */
  async store(
    collection: string,
    documents: VectorDocument[]
  ): Promise<void> {
    if (documents.length === 0) return;

    const tracer = getTracer();
    return tracer.startActiveSpan(
      "cluster-whisperer.vectorstore.store",
      { kind: SpanKind.CLIENT },
      async (span) => {
        span.setAttribute("db.system", "qdrant");
        span.setAttribute("db.operation.name", "upsert");
        span.setAttribute("db.collection.name", collection);
        span.setAttribute(
          "cluster_whisperer.vectorstore.document_count",
          documents.length
        );

        try {
          this.ensureInitialized(collection);

          for (let i = 0; i < documents.length; i += UPSERT_BATCH_SIZE) {
            const batch = documents.slice(i, i + UPSERT_BATCH_SIZE);
            const texts = batch.map((doc) => doc.text);
            const embeddings = await this.embedder.embed(texts);

            const points = batch.map((doc, idx) => ({
              id: stringToUuidV5(doc.id),
              vector: embeddings[idx],
              payload: {
                [ORIGINAL_ID_KEY]: doc.id,
                document: doc.text,
                ...doc.metadata,
              },
            }));

            await this.client.upsert(collection, { points });
          }

          span.setStatus({ code: SpanStatusCode.OK });
        } catch (error) {
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: error instanceof Error ? error.message : String(error),
          });
          span.recordException(error as Error);
          throw error;
        } finally {
          span.end();
        }
      }
    );
  }

  /**
   * Searches a collection using natural language.
   *
   * Embeds the query text, then uses Qdrant's query() API (the modern
   * replacement for the deprecated search() API) to find similar points.
   * Results are returned sorted by score (highest = most similar).
   *
   * Qdrant query() returns scores as similarity (higher = better), which
   * is the inverse of Chroma's distance (lower = better). We return the
   * score as-is — callers should treat scores as backend-specific.
   */
  async search(
    collection: string,
    query: string,
    options?: SearchOptions
  ): Promise<SearchResult[]> {
    const tracer = getTracer();

    return tracer.startActiveSpan(
      "cluster-whisperer.vectorstore.search",
      { kind: SpanKind.CLIENT },
      async (span) => {
        span.setAttribute("db.system", "qdrant");
        span.setAttribute("db.operation.name", "query");
        span.setAttribute("db.collection.name", collection);

        try {
          this.ensureInitialized(collection);

          const queryEmbeddings = await this.embedder.embed([query]);

          const filter = this.buildFilter(options?.where, options?.whereDocument);

          const results = await this.client.query(collection, {
            query: queryEmbeddings[0],
            limit: options?.nResults ?? 10,
            with_payload: true,
            ...(filter ? { filter } : {}),
          });

          const searchResults = (results.points ?? []).map((point) => {
            const payload = (point.payload ?? {}) as Record<string, unknown>;
            const { document, [ORIGINAL_ID_KEY]: originalId, ...metadata } =
              payload;
            return {
              id: (originalId as string) ?? String(point.id),
              text: (document as string) ?? "",
              metadata: metadata as Record<string, string | number | boolean>,
              score: point.score ?? 0,
            };
          });

          span.setAttribute(
            "cluster_whisperer.vectorstore.result_count",
            searchResults.length
          );
          span.setStatus({ code: SpanStatusCode.OK });
          return searchResults;
        } catch (error) {
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: error instanceof Error ? error.message : String(error),
          });
          span.recordException(error as Error);
          throw error;
        } finally {
          span.end();
        }
      }
    );
  }

  /**
   * Searches a collection by keyword/metadata filtering — no embedding API call.
   *
   * Uses Qdrant's scroll() API which retrieves points by filter without
   * vector similarity. This is the equivalent of Chroma's collection.get().
   *
   * For keyword matching, we use Qdrant's full-text match filter on the
   * "document" payload field. This is a token-level match (not substring),
   * which is Qdrant's closest equivalent to Chroma's $contains.
   *
   * Results have score = -1 since there's no vector comparison.
   */
  async keywordSearch(
    collection: string,
    keyword?: string,
    options?: SearchOptions
  ): Promise<SearchResult[]> {
    const tracer = getTracer();

    return tracer.startActiveSpan(
      "cluster-whisperer.vectorstore.keyword_search",
      { kind: SpanKind.CLIENT },
      async (span) => {
        span.setAttribute("db.system", "qdrant");
        span.setAttribute("db.operation.name", "scroll");
        span.setAttribute("db.collection.name", collection);

        try {
          this.ensureInitialized(collection);

          const filter = this.buildFilter(options?.where, undefined, keyword);

          const results = await this.client.scroll(collection, {
            filter: filter ?? undefined,
            limit: options?.nResults ?? 10,
            with_payload: true,
            with_vector: false,
          });

          const searchResults = (results.points ?? []).map((point) => {
            const payload = (point.payload ?? {}) as Record<string, unknown>;
            const { document, [ORIGINAL_ID_KEY]: originalId, ...metadata } =
              payload;
            return {
              id: (originalId as string) ?? String(point.id),
              text: (document as string) ?? "",
              metadata: metadata as Record<string, string | number | boolean>,
              score: -1,
            };
          });

          span.setAttribute(
            "cluster_whisperer.vectorstore.result_count",
            searchResults.length
          );
          span.setStatus({ code: SpanStatusCode.OK });
          return searchResults;
        } catch (error) {
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: error instanceof Error ? error.message : String(error),
          });
          span.recordException(error as Error);
          throw error;
        } finally {
          span.end();
        }
      }
    );
  }

  /**
   * Deletes points from a collection by ID.
   */
  async delete(collection: string, ids: string[]): Promise<void> {
    const tracer = getTracer();

    return tracer.startActiveSpan(
      "cluster-whisperer.vectorstore.delete",
      { kind: SpanKind.CLIENT },
      async (span) => {
        span.setAttribute("db.system", "qdrant");
        span.setAttribute("db.operation.name", "delete");
        span.setAttribute("db.collection.name", collection);
        span.setAttribute(
          "cluster_whisperer.vectorstore.document_count",
          ids.length
        );

        try {
          this.ensureInitialized(collection);
          await this.client.delete(collection, {
            points: ids.map((id) => stringToUuidV5(id)),
          });
          span.setStatus({ code: SpanStatusCode.OK });
        } catch (error) {
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: error instanceof Error ? error.message : String(error),
          });
          span.recordException(error as Error);
          throw error;
        } finally {
          span.end();
        }
      }
    );
  }

  /**
   * Translates VectorStore filter formats to Qdrant's filter structure.
   *
   * The VectorStore interface uses Chroma-style flat key-value pairs for
   * metadata filtering (e.g., { kind: "Deployment", apiGroup: "apps" }).
   * Qdrant uses a must/should/must_not structure with typed conditions.
   *
   * Translation:
   *   { kind: "Deployment" }
   *   → { must: [{ key: "kind", match: { value: "Deployment" } }] }
   *
   * For keyword search, we add a full-text match on the "document" payload field:
   *   keyword: "backup"
   *   → { must: [{ key: "document", match: { text: "backup" } }] }
   */
  private buildFilter(
    where?: Record<string, unknown>,
    whereDocument?: Record<string, unknown>,
    keyword?: string
  ): { must: Array<Record<string, unknown>> } | undefined {
    const conditions: Array<Record<string, unknown>> = [];

    // Add keyword text filter on the "document" payload field
    if (keyword) {
      conditions.push({ key: "document", match: { text: keyword } });
    }

    // Add whereDocument filter (for search() with whereDocument option)
    if (whereDocument) {
      const contains =
        whereDocument["$contains"] ?? whereDocument["$Contains"];
      if (contains) {
        conditions.push({
          key: "document",
          match: { text: String(contains) },
        });
      }
    }

    // Translate flat key-value metadata filters to Qdrant must conditions
    if (where) {
      for (const [key, value] of Object.entries(where)) {
        // Skip Chroma-specific operators ($and, $or, etc.)
        if (key.startsWith("$")) continue;
        conditions.push({ key, match: { value } });
      }
    }

    if (conditions.length === 0) return undefined;
    return { must: conditions };
  }

  /**
   * Throws if a collection hasn't been initialized.
   *
   * Same guard as ChromaBackend.getCollection() — prevents operations
   * on collections that haven't been set up with the right vector config.
   */
  private ensureInitialized(collection: string): void {
    if (!this.initializedCollections.has(collection)) {
      throw new Error(
        `Collection "${collection}" has not been initialized. ` +
          `Call initialize("${collection}", { distanceMetric: "cosine" }) first.`
      );
    }
  }
}
