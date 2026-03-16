// ABOUTME: Unit tests for the vector backend factory
// ABOUTME: Verifies routing to ChromaBackend or QdrantBackend based on --vector-backend flag

/**
 * Tests for the backend factory module.
 *
 * The factory creates the right VectorStore implementation based on the
 * --vector-backend CLI flag:
 * - "chroma" creates a ChromaBackend
 * - "qdrant" creates a QdrantBackend
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Use vi.hoisted so the spy is available during vi.mock hoisting
const { MockChromaBackend, MockQdrantBackend } = vi.hoisted(() => {
  const MockChromaBackend = vi.fn();
  const MockQdrantBackend = vi.fn();
  return { MockChromaBackend, MockQdrantBackend };
});

vi.mock("./chroma-backend", () => ({
  ChromaBackend: MockChromaBackend,
}));

vi.mock("./qdrant-backend", () => ({
  QdrantBackend: MockQdrantBackend,
}));

import { createVectorStore } from "./backend-factory";
import { ChromaBackend } from "./chroma-backend";
import { QdrantBackend } from "./qdrant-backend";
import type { EmbeddingFunction } from "./types";

const mockEmbedder: EmbeddingFunction = {
  embed: vi.fn().mockResolvedValue([[0.1, 0.2, 0.3]]),
};

describe("createVectorStore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates a ChromaBackend when backendType is 'chroma'", () => {
    const store = createVectorStore(mockEmbedder, "chroma");

    expect(ChromaBackend).toHaveBeenCalledTimes(1);
    expect(QdrantBackend).not.toHaveBeenCalled();
    expect(store).toBeDefined();
  });

  it("creates a QdrantBackend when backendType is 'qdrant'", () => {
    const store = createVectorStore(mockEmbedder, "qdrant");

    expect(QdrantBackend).toHaveBeenCalledTimes(1);
    expect(ChromaBackend).not.toHaveBeenCalled();
    expect(store).toBeDefined();
  });

  it("passes chromaUrl option to ChromaBackend", () => {
    createVectorStore(mockEmbedder, "chroma", {
      chromaUrl: "http://chroma:9000",
    });

    expect(ChromaBackend).toHaveBeenCalledWith(mockEmbedder, {
      chromaUrl: "http://chroma:9000",
    });
  });

  it("passes qdrantUrl option to QdrantBackend", () => {
    createVectorStore(mockEmbedder, "qdrant", {
      qdrantUrl: "http://qdrant:6334",
    });

    expect(QdrantBackend).toHaveBeenCalledWith(mockEmbedder, {
      qdrantUrl: "http://qdrant:6334",
    });
  });

  it("defaults chromaUrl to undefined when not specified", () => {
    createVectorStore(mockEmbedder, "chroma");

    expect(ChromaBackend).toHaveBeenCalledWith(mockEmbedder, {
      chromaUrl: undefined,
    });
  });

  it("defaults qdrantUrl to undefined when not specified", () => {
    createVectorStore(mockEmbedder, "qdrant");

    expect(QdrantBackend).toHaveBeenCalledWith(mockEmbedder, {
      qdrantUrl: undefined,
    });
  });
});
