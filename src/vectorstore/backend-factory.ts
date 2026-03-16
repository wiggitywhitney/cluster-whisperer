// ABOUTME: Factory that creates the right VectorStore backend based on --vector-backend flag
// ABOUTME: Routes to ChromaBackend or QdrantBackend, keeping callers backend-agnostic

/**
 * Backend factory — constructs the right VectorStore based on the --vector-backend CLI flag.
 *
 * This factory decouples the CLI and agent from specific backend implementations.
 * Callers pass a VectorBackendType and get back a VectorStore interface — they
 * never need to know which backend is behind it.
 *
 * Currently supported:
 * - chroma: ChromaDB (existing default)
 * - qdrant: Qdrant vector database
 */

import { ChromaBackend } from "./chroma-backend";
import { QdrantBackend } from "./qdrant-backend";
import type { EmbeddingFunction, VectorStore } from "./types";
import type { VectorBackendType } from "./backend-types";

/**
 * Options for creating a vector store backend.
 */
export interface CreateVectorStoreOptions {
  /** Chroma server URL (used when backendType is "chroma") */
  chromaUrl?: string;
  /** Qdrant server URL (used when backendType is "qdrant") */
  qdrantUrl?: string;
}

/**
 * Creates a VectorStore using the specified backend.
 *
 * @param embedder - Embedding function for converting text to vectors
 * @param backendType - Which backend to create ("chroma" or "qdrant")
 * @param options - Backend-specific URL configuration
 * @returns A VectorStore instance for the requested backend
 */
export function createVectorStore(
  embedder: EmbeddingFunction,
  backendType: VectorBackendType,
  options?: CreateVectorStoreOptions
): VectorStore {
  switch (backendType) {
    case "chroma":
      return new ChromaBackend(embedder, {
        chromaUrl: options?.chromaUrl,
      });

    case "qdrant":
      return new QdrantBackend(embedder, {
        qdrantUrl: options?.qdrantUrl,
      });

    default: {
      const _exhaustive: never = backendType;
      throw new Error(`Unknown vector backend: ${_exhaustive}`);
    }
  }
}
