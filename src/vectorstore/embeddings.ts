/**
 * embeddings.ts - Voyage AI embedding implementation
 *
 * What this file does:
 * Implements the EmbeddingFunction interface using Voyage AI's embedding API.
 * Voyage AI is Anthropic's official embedding partner — it turns text into
 * vectors that capture semantic meaning for similarity search.
 *
 * Why Voyage AI?
 * - Anthropic's recommended embedding provider (no Anthropic embedding API exists)
 * - voyage-4 model: 1024 dimensions, $0.06/1M tokens with 200M tokens free
 * - Effectively free at our data volumes (a few hundred CRDs)
 * - Good quality for technical documentation search
 *
 * How it works:
 * 1. Text strings go in (e.g., "SQL — A managed database solution...")
 * 2. Voyage AI's API returns 1024-dimensional vectors
 * 3. Similar texts produce similar vectors (close in cosine distance)
 * 4. These vectors get stored in the vector database for similarity search
 */

import { VoyageAIClient } from "voyageai";
import type { EmbeddingFunction } from "./types";

/**
 * Default embedding model.
 *
 * voyage-4 is Voyage AI's current-generation model with 1024 dimensions.
 * Configurable via constructor in case the model name changes or you
 * want to try a different model (voyage-4-lite for speed, voyage-code-3
 * for code-heavy content).
 */
const DEFAULT_MODEL = "voyage-4";

/**
 * Embedding function that uses Voyage AI's API to convert text to vectors.
 *
 * Usage:
 *   const embedder = new VoyageEmbedding();  // uses VOYAGE_API_KEY env var
 *   const vectors = await embedder.embed(["managed database", "load balancer"]);
 *   // vectors[0] = [0.012, -0.034, ...] (1024 numbers)
 *   // vectors[1] = [0.056, 0.011, ...] (1024 numbers)
 */
export class VoyageEmbedding implements EmbeddingFunction {
  private readonly client: VoyageAIClient;
  private readonly model: string;

  /**
   * Creates a new Voyage AI embedding function.
   *
   * @param options - Configuration options
   * @param options.apiKey - Voyage AI API key. Defaults to VOYAGE_API_KEY env var.
   * @param options.model - Model to use. Defaults to "voyage-4".
   */
  constructor(options?: { apiKey?: string; model?: string }) {
    const apiKey = options?.apiKey ?? process.env.VOYAGE_API_KEY;
    if (!apiKey) {
      throw new Error(
        "Voyage AI API key is required. Set VOYAGE_API_KEY environment variable " +
          "or pass apiKey in options."
      );
    }

    this.client = new VoyageAIClient({ apiKey });
    this.model = options?.model ?? DEFAULT_MODEL;
  }

  /**
   * Converts text strings into embedding vectors using Voyage AI.
   *
   * Sends the texts to Voyage AI's API in a single batch request.
   * The API handles batching internally (up to 128 texts per request).
   *
   * @param texts - Array of text strings to embed
   * @returns Array of embedding vectors (one per input text)
   * @throws Error if the API call fails or returns unexpected data
   */
  async embed(texts: string[]): Promise<number[][]> {
    const response = await this.client.embed({
      input: texts,
      model: this.model,
    });

    // Extract embedding vectors from the response
    // The API returns { data: [{ embedding: number[], index: number }, ...] }
    if (!response.data) {
      throw new Error("Voyage AI returned no embedding data");
    }

    // Sort by index to ensure order matches input order
    const sorted = [...response.data].sort(
      (a, b) => (a.index ?? 0) - (b.index ?? 0)
    );

    return sorted.map((item) => {
      if (!item.embedding) {
        throw new Error("Voyage AI returned an embedding without vector data");
      }
      return item.embedding;
    });
  }
}
