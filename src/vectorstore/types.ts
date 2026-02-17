/**
 * types.ts - Vector database interfaces and types
 *
 * What this file does:
 * Defines the interfaces that the rest of the system uses to interact with
 * the vector database. This is the abstraction layer — PRDs #25 and #26
 * import from here and never touch Chroma (or any other backend) directly.
 *
 * Why an abstraction layer?
 * The KubeCon demo shows both Chroma and Qdrant as vector database options.
 * By coding against interfaces, the data loading pipelines work with either
 * backend. Swap the implementation, keep the same pipeline code.
 *
 * Key concepts:
 * - VectorStore: The main interface for storing and searching documents
 * - EmbeddingFunction: Turns text into numbers (vectors) for similarity search
 * - VectorDocument: A document to store (text + metadata)
 * - SearchResult: A document found by similarity search (text + metadata + score)
 */

/**
 * A function that converts text into embedding vectors.
 *
 * What are embeddings?
 * When you embed text, you turn it into an array of numbers (a "vector") that
 * captures the meaning of the text. Similar texts produce similar vectors.
 * This is what makes semantic search possible — "find resources related to
 * databases" works because the query vector is close to vectors for database
 * resources, even if the exact words differ.
 *
 * Why an interface?
 * Different embedding models (Voyage AI, OpenAI, local models) all do the
 * same thing — text in, numbers out. The interface lets us swap models without
 * changing any vector store or pipeline code.
 */
export interface EmbeddingFunction {
  /**
   * Converts an array of text strings into embedding vectors.
   *
   * @param texts - The strings to embed (e.g., document descriptions)
   * @returns A 2D array: one vector (number[]) per input text
   */
  embed(texts: string[]): Promise<number[][]>;
}

/**
 * A document to store in the vector database.
 *
 * Each document has three parts:
 * - id: A unique identifier (e.g., "apps/v1/Deployment")
 * - text: The content to embed and search against
 * - metadata: Structured fields for filtering (kind, apiGroup, etc.)
 *
 * The text gets embedded into a vector for similarity search.
 * The metadata stays as-is for exact-match filtering (e.g., "find all CRDs").
 */
export interface VectorDocument {
  /** Unique identifier for the document (used for updates and deletes) */
  id: string;
  /** The text content to embed — this is what semantic search matches against */
  text: string;
  /** Structured metadata for filtering — not embedded, used for exact queries */
  metadata: Record<string, string | number | boolean>;
}

/**
 * A search result returned from a similarity query.
 *
 * Extends VectorDocument with a similarity score so the caller can
 * decide how relevant each result is.
 */
export interface SearchResult {
  /** Unique identifier of the matched document */
  id: string;
  /** The original text content */
  text: string;
  /** Structured metadata from the original document */
  metadata: Record<string, string | number | boolean>;
  /**
   * How similar this result is to the query.
   *
   * With cosine distance: 0.0 = identical, 2.0 = opposite.
   * Lower scores mean more similar results.
   * Chroma returns distances, not similarity scores.
   */
  score: number;
}

/**
 * Options for creating a collection.
 *
 * A collection is like a table — it groups related documents together.
 * We use two collections: one for capability descriptions (what resource
 * types can do) and one for resource instances (what's running).
 */
export interface CollectionOptions {
  /**
   * The distance metric for comparing vectors.
   *
   * - "cosine": Standard for text embeddings. Measures angle between vectors,
   *   ignoring magnitude. Two vectors pointing the same direction score 0.0,
   *   regardless of length. This is what we use.
   * - "l2": Euclidean distance. Sensitive to vector magnitude.
   * - "ip": Inner product. Used with normalized vectors.
   *
   * Must be set at collection creation time — cannot be changed later.
   */
  distanceMetric: "cosine" | "l2" | "ip";
}

/**
 * Options for searching a collection.
 */
export interface SearchOptions {
  /** Maximum number of results to return (default: 10) */
  nResults?: number;
  /**
   * Metadata filter for exact-match queries.
   *
   * Example: { kind: "Deployment" } only returns documents where
   * metadata.kind === "Deployment". This narrows the search before
   * comparing vectors, making it faster and more precise.
   *
   * Uses Chroma's where syntax under the hood. Simple key-value pairs
   * do exact matching. For advanced operators ($gt, $in, etc.), pass
   * them as nested objects per the Chroma docs.
   */
  where?: Record<string, unknown>;
}

/**
 * The main interface for vector database operations.
 *
 * This is what PRDs #25 and #26 code against. They call store() to add
 * documents and never need to know whether Chroma or Qdrant is behind it.
 *
 * The agent's search tools (M3) will call search() to find relevant resources.
 *
 * Usage pattern:
 *   1. initialize() — create the collection (idempotent, safe to call twice)
 *   2. store() — add documents (embeddings computed automatically)
 *   3. search() — find similar documents by natural language query
 *   4. delete() — remove documents by ID
 */
export interface VectorStore {
  /**
   * Creates a collection if it doesn't exist, or returns the existing one.
   *
   * Idempotent — calling this twice with the same name is safe. This matters
   * because PRDs #25 and #26 both call initialize independently, and re-running
   * a sync script shouldn't fail because collections already exist.
   *
   * @param collection - Name of the collection (e.g., "capabilities")
   * @param options - Configuration like distance metric
   */
  initialize(collection: string, options: CollectionOptions): Promise<void>;

  /**
   * Stores documents in a collection.
   *
   * Each document's text is embedded automatically (using the configured
   * embedding function) and stored alongside its metadata. If a document
   * with the same ID already exists, it is updated (upsert behavior).
   *
   * @param collection - Which collection to store in
   * @param documents - The documents to store
   */
  store(collection: string, documents: VectorDocument[]): Promise<void>;

  /**
   * Searches a collection using natural language.
   *
   * The query text is embedded into a vector, then compared against all
   * stored document vectors using the collection's distance metric. Returns
   * the closest matches, optionally filtered by metadata.
   *
   * @param collection - Which collection to search
   * @param query - Natural language query (e.g., "managed database")
   * @param options - Optional: limit results, filter by metadata
   * @returns Matching documents sorted by similarity (best first)
   */
  search(
    collection: string,
    query: string,
    options?: SearchOptions
  ): Promise<SearchResult[]>;

  /**
   * Deletes documents from a collection by ID.
   *
   * @param collection - Which collection to delete from
   * @param ids - IDs of documents to remove
   */
  delete(collection: string, ids: string[]): Promise<void>;
}
