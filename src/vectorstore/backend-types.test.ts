// ABOUTME: Unit tests for vector backend type parsing and validation
// ABOUTME: Verifies --vector-backend flag parsing, defaults, and error handling

/**
 * Tests for the backend-type parsing module.
 *
 * The --vector-backend CLI flag selects which vector database backend to use.
 * These tests verify:
 * - Valid backend types are accepted
 * - Invalid types produce helpful error messages
 * - The default is "chroma" for backwards compatibility
 */

import { describe, it, expect } from "vitest";
import {
  parseVectorBackend,
  VALID_VECTOR_BACKENDS,
  DEFAULT_VECTOR_BACKEND,
  type VectorBackendType,
} from "./backend-types";

describe("parseVectorBackend", () => {
  it("accepts 'chroma'", () => {
    expect(parseVectorBackend("chroma")).toBe("chroma");
  });

  it("accepts 'qdrant'", () => {
    expect(parseVectorBackend("qdrant")).toBe("qdrant");
  });

  it("trims whitespace", () => {
    expect(parseVectorBackend("  qdrant  ")).toBe("qdrant");
  });

  it("throws on invalid backend type", () => {
    expect(() => parseVectorBackend("pinecone")).toThrow(
      /Unknown vector backend: "pinecone"/
    );
  });

  it("throws on empty string", () => {
    expect(() => parseVectorBackend("")).toThrow(
      /Must specify a vector backend/i
    );
  });

  it("throws on whitespace-only string", () => {
    expect(() => parseVectorBackend("   ")).toThrow(
      /Must specify a vector backend/i
    );
  });
});

describe("VALID_VECTOR_BACKENDS", () => {
  it("contains chroma and qdrant", () => {
    expect(VALID_VECTOR_BACKENDS).toEqual(["chroma", "qdrant"]);
  });
});

describe("DEFAULT_VECTOR_BACKEND", () => {
  it("defaults to chroma for backwards compatibility", () => {
    expect(DEFAULT_VECTOR_BACKEND).toBe("chroma");
  });
});
