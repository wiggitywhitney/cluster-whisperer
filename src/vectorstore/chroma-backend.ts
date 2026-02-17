/**
 * chroma-backend.ts - Chroma implementation of the VectorStore interface
 *
 * What this file does:
 * Implements the VectorStore interface using Chroma as the backend. This is the
 * only file in the project that imports from "chromadb" — everything else codes
 * against the VectorStore interface in types.ts.
 *
 * Why isolate Chroma to one file?
 * The KubeCon demo shows both Chroma and Qdrant. A future Qdrant backend would
 * implement the same VectorStore interface in a qdrant-backend.ts file. The
 * pipelines (PRDs #25 and #26) and search tools (M3) never change.
 *
 * How it works:
 * 1. initialize() creates a Chroma collection with cosine distance
 * 2. store() embeds document text via our EmbeddingFunction, then stores
 *    the vectors + metadata in Chroma
 * 3. search() embeds the query, runs vector similarity search in Chroma,
 *    and returns results sorted by distance
 * 4. delete() removes documents by ID
 *
 * We pass pre-computed embeddings to Chroma (not a Chroma embedding function).
 * This keeps our EmbeddingFunction interface clean and backend-agnostic.
 */

import { ChromaClient, type Collection, type Where } from "chromadb";
import type {
  VectorStore,
  VectorDocument,
  SearchResult,
  CollectionOptions,
  SearchOptions,
  EmbeddingFunction,
} from "./types";

/**
 * Default Chroma server URL.
 *
 * The TypeScript SDK always requires a running Chroma server (no in-process
 * mode like Python). Run `chroma run --path ./data` locally or use Docker.
 *
 * Override with the CHROMA_URL environment variable for non-default setups.
 */
const DEFAULT_CHROMA_URL = "http://localhost:8000";

/**
 * Chroma implementation of the VectorStore interface.
 *
 * Usage:
 *   const embedder = new VoyageEmbedding();
 *   const store = new ChromaBackend(embedder);
 *
 *   await store.initialize("capabilities", { distanceMetric: "cosine" });
 *   await store.store("capabilities", [{ id: "...", text: "...", metadata: {} }]);
 *   const results = await store.search("capabilities", "managed database");
 */
export class ChromaBackend implements VectorStore {
  private readonly client: ChromaClient;
  private readonly embedder: EmbeddingFunction;

  /**
   * Cache of initialized collections.
   *
   * Why cache?
   * Each store() and search() call needs the collection object. Without caching,
   * we'd call Chroma's getOrCreateCollection on every operation, which is an
   * unnecessary network round-trip. The cache maps collection name → Collection.
   */
  private readonly collections: Map<string, Collection> = new Map();

  /**
   * Creates a new Chroma backend.
   *
   * @param embedder - The embedding function to use for converting text to vectors.
   *                   Injected at construction so the embedding model can be swapped
   *                   independently of the vector database.
   * @param options - Optional configuration
   * @param options.chromaUrl - Chroma server URL. Defaults to CHROMA_URL env var
   *                           or http://localhost:8000.
   */
  constructor(
    embedder: EmbeddingFunction,
    options?: { chromaUrl?: string }
  ) {
    this.embedder = embedder;
    const url = options?.chromaUrl ?? process.env.CHROMA_URL ?? DEFAULT_CHROMA_URL;

    // Parse the URL into host and port for the Chroma v3 SDK.
    // The 'path' constructor argument is deprecated in favor of host/port/ssl.
    const parsed = new URL(url);
    this.client = new ChromaClient({
      host: parsed.hostname,
      port: parseInt(parsed.port || (parsed.protocol === "https:" ? "443" : "8000"), 10),
      ssl: parsed.protocol === "https:",
    });
  }

  /**
   * Creates a collection if it doesn't exist, or gets the existing one.
   *
   * Uses Chroma's getOrCreateCollection for idempotency — safe to call
   * multiple times with the same name. The distance metric is set at creation
   * time and cannot be changed later.
   *
   * We pass embeddingFunction: null to tell Chroma we'll provide pre-computed
   * embeddings. Without this, Chroma tries to use a default embedding function
   * which requires the @chroma-core/default-embed package.
   */
  async initialize(
    collection: string,
    options: CollectionOptions
  ): Promise<void> {
    const chromaCollection = await this.client.getOrCreateCollection({
      name: collection,
      configuration: {
        hnsw: { space: options.distanceMetric },
      },
      embeddingFunction: null,
    });

    this.collections.set(collection, chromaCollection);
  }

  /**
   * Stores documents in a Chroma collection.
   *
   * The process:
   * 1. Extract text from all documents
   * 2. Embed the text using our EmbeddingFunction (Voyage AI)
   * 3. Send IDs, embeddings, documents, and metadata to Chroma via upsert
   *
   * Why upsert instead of add?
   * If a document with the same ID already exists, upsert updates it.
   * add() would throw an error on duplicate IDs. Since sync pipelines
   * (PRDs #25 and #26) re-run periodically, upsert is the right behavior.
   */
  async store(
    collection: string,
    documents: VectorDocument[]
  ): Promise<void> {
    const chromaCollection = this.getCollection(collection);

    if (documents.length === 0) return;

    // Embed all document texts in a single batch
    const texts = documents.map((doc) => doc.text);
    const embeddings = await this.embedder.embed(texts);

    // Upsert into Chroma — creates new or updates existing documents
    await chromaCollection.upsert({
      ids: documents.map((doc) => doc.id),
      embeddings,
      documents: texts,
      metadatas: documents.map((doc) => doc.metadata),
    });
  }

  /**
   * Searches a collection using natural language.
   *
   * The process:
   * 1. Embed the query text into a vector
   * 2. Send the vector to Chroma for similarity search
   * 3. Convert Chroma's column-oriented results into SearchResult objects
   *
   * Chroma returns results sorted by distance (closest first).
   * With cosine distance: 0.0 = identical, 2.0 = completely opposite.
   */
  async search(
    collection: string,
    query: string,
    options?: SearchOptions
  ): Promise<SearchResult[]> {
    const chromaCollection = this.getCollection(collection);

    // Embed the query text
    const queryEmbeddings = await this.embedder.embed([query]);

    // Build query parameters
    const results = await chromaCollection.query({
      queryEmbeddings,
      nResults: options?.nResults ?? 10,
      include: ["documents", "metadatas", "distances"],
      // Cast to Chroma's Where type — our SearchOptions.where accepts the
      // same shape (key-value pairs for exact match, or $and/$or operators)
      ...(options?.where ? { where: options.where as Where } : {}),
    });

    // Convert Chroma's column-oriented format to SearchResult objects.
    //
    // Chroma returns nested arrays because query() supports multiple
    // queries at once. We always send one query, so we use index [0]
    // to get the results for our single query.
    const ids = results.ids[0] ?? [];
    const documents = results.documents[0] ?? [];
    const metadatas = results.metadatas[0] ?? [];
    const distances = results.distances[0] ?? [];

    return ids.map((id, i) => ({
      id,
      text: documents[i] ?? "",
      metadata: (metadatas[i] ?? {}) as Record<string, string | number | boolean>,
      score: distances[i] ?? 0,
    }));
  }

  /**
   * Deletes documents from a collection by ID.
   */
  async delete(collection: string, ids: string[]): Promise<void> {
    const chromaCollection = this.getCollection(collection);
    await chromaCollection.delete({ ids });
  }

  /**
   * Gets a cached collection, throwing if it hasn't been initialized.
   *
   * Why not auto-initialize?
   * Initialization requires configuration (distance metric). If we auto-
   * initialized with defaults, we might create a collection with the wrong
   * metric, and distance metrics can't be changed after creation.
   * Explicit initialization prevents this class of bugs.
   */
  private getCollection(name: string): Collection {
    const collection = this.collections.get(name);
    if (!collection) {
      throw new Error(
        `Collection "${name}" has not been initialized. ` +
          `Call initialize("${name}", { distanceMetric: "cosine" }) first.`
      );
    }
    return collection;
  }
}
