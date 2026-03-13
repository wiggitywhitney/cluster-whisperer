// ABOUTME: Parses and validates the --vector-backend CLI flag for backend selection
// ABOUTME: Maps backend names (chroma, qdrant) to the backend factory

/**
 * Backend-type parsing for the --vector-backend CLI flag.
 *
 * The "Choose Your Own Adventure" demo can switch between vector databases:
 * - chroma: The existing ChromaDB backend (default)
 * - qdrant: Qdrant vector database backend
 *
 * This module parses the flag value and validates that the backend type
 * is recognized. The default (chroma) preserves backwards compatibility.
 */

/**
 * Valid vector backend names that the --vector-backend flag accepts.
 *
 * Each type maps to a different vector database:
 * - chroma: ChromaDB (current default implementation)
 * - qdrant: Qdrant vector database
 */
export const VALID_VECTOR_BACKENDS = ["chroma", "qdrant"] as const;

/**
 * TypeScript type for a valid vector backend name.
 * Derived from the VALID_VECTOR_BACKENDS array so the type stays in sync.
 */
export type VectorBackendType = (typeof VALID_VECTOR_BACKENDS)[number];

/**
 * Default vector backend when --vector-backend is not specified.
 * Chroma matches the existing behavior (before this flag existed).
 */
export const DEFAULT_VECTOR_BACKEND: VectorBackendType = "chroma";

/**
 * Parses a vector backend string into a validated VectorBackendType.
 *
 * @param input - Backend type name (e.g., "chroma" or "qdrant")
 * @returns Validated VectorBackendType value
 * @throws Error if the backend type is unrecognized or input is empty
 *
 * @example
 * parseVectorBackend("chroma")   // → "chroma"
 * parseVectorBackend("qdrant")   // → "qdrant"
 * parseVectorBackend("pinecone") // throws: Unknown vector backend: "pinecone"
 */
export function parseVectorBackend(input: string): VectorBackendType {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error(
      `Must specify a vector backend. Valid backends: ${VALID_VECTOR_BACKENDS.join(", ")}`
    );
  }

  if (!VALID_VECTOR_BACKENDS.includes(trimmed as VectorBackendType)) {
    throw new Error(
      `Unknown vector backend: "${trimmed}". Valid backends: ${VALID_VECTOR_BACKENDS.join(", ")}`
    );
  }

  return trimmed as VectorBackendType;
}
