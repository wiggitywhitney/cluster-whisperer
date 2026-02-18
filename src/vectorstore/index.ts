/**
 * vectorstore/index.ts - Public API for the vector store module
 *
 * What this file does:
 * Re-exports everything other modules need from the vector store system.
 * Import from here — never import directly from types.ts, embeddings.ts,
 * or chroma-backend.ts.
 *
 * Usage:
 *   import {
 *     ChromaBackend,
 *     VoyageEmbedding,
 *     CAPABILITIES_COLLECTION,
 *     INSTANCES_COLLECTION,
 *     type VectorStore,
 *     type VectorDocument,
 *   } from "./vectorstore";
 */

// Interfaces and types — what PRDs #25 and #26 code against
export type {
  VectorStore,
  VectorDocument,
  SearchResult,
  SearchOptions,
  CollectionOptions,
  EmbeddingFunction,
} from "./types";

// Implementations — wired together at startup
export { ChromaBackend } from "./chroma-backend";
export { VoyageEmbedding } from "./embeddings";

/**
 * Collection name for capability descriptions.
 *
 * Stores one document per Kubernetes resource *type* (e.g., "Deployment",
 * "SQLClaim"). Each document has an AI-generated description of what the
 * resource does, its capabilities, and when to use it.
 *
 * Populated by PRD #25 (Capability Inference Pipeline).
 * Searched when the agent needs to answer "how do I deploy a database?"
 */
export const CAPABILITIES_COLLECTION = "capabilities";

/**
 * Collection name for resource instance metadata.
 *
 * Stores one document per running Kubernetes resource *instance* (e.g., each
 * individual Deployment, Service, or Pod). Each document has identity metadata
 * like name, namespace, kind, and labels.
 *
 * Populated by PRD #26 (Resource Instance Sync).
 * Searched when the agent needs to answer "what databases are running?"
 */
export const INSTANCES_COLLECTION = "instances";
