/**
 * storage.test.ts - Unit tests for vector storage of capability descriptions (M3)
 *
 * Tests the mapping from ResourceCapability to VectorDocument and the
 * orchestration of storing capabilities in the vector database. Uses a
 * mock VectorStore at the system boundary — no Chroma or Voyage AI needed.
 */

import { describe, it, expect, vi } from "vitest";
import { capabilityToDocument, storeCapabilities } from "./storage";
import type { ResourceCapability } from "./types";
import type { VectorStore, VectorDocument } from "../vectorstore";

// ---------------------------------------------------------------------------
// Test fixture helpers
// ---------------------------------------------------------------------------

/**
 * Creates a ResourceCapability with sensible defaults.
 * Override the specific fields relevant to each test case.
 */
function makeCapability(
  overrides: Partial<ResourceCapability> = {}
): ResourceCapability {
  return {
    resourceName: "sqls.devopstoolkit.live",
    apiVersion: "devopstoolkit.live/v1beta1",
    group: "devopstoolkit.live",
    kind: "SQL",
    capabilities: ["database", "postgresql", "mysql"],
    providers: ["aws", "gcp", "azure"],
    complexity: "low",
    description:
      "Managed database solution supporting multiple SQL engine types.",
    useCase:
      "Deploy a managed SQL database without dealing with infrastructure complexity.",
    confidence: 0.9,
    ...overrides,
  };
}

/**
 * Creates a mock VectorStore with all methods stubbed.
 * Captures arguments for assertion without any real storage.
 */
function createMockVectorStore(): VectorStore & {
  initialize: ReturnType<typeof vi.fn>;
  store: ReturnType<typeof vi.fn>;
  search: ReturnType<typeof vi.fn>;
  keywordSearch: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
} {
  return {
    initialize: vi.fn().mockResolvedValue(undefined),
    store: vi.fn().mockResolvedValue(undefined),
    search: vi.fn().mockResolvedValue([]),
    keywordSearch: vi.fn().mockResolvedValue([]),
    delete: vi.fn().mockResolvedValue(undefined),
  };
}

// ---------------------------------------------------------------------------
// capabilityToDocument
// ---------------------------------------------------------------------------

describe("capabilityToDocument", () => {
  it("uses resourceName as the document id", () => {
    const capability = makeCapability({
      resourceName: "sqls.devopstoolkit.live",
    });

    const doc = capabilityToDocument(capability);

    expect(doc.id).toBe("sqls.devopstoolkit.live");
  });

  it("includes kind and group in embedding text", () => {
    const capability = makeCapability({
      kind: "SQL",
      group: "devopstoolkit.live",
    });

    const doc = capabilityToDocument(capability);

    expect(doc.text).toContain("SQL");
    expect(doc.text).toContain("devopstoolkit.live");
  });

  it("includes capabilities as search terms in embedding text", () => {
    const capability = makeCapability({
      capabilities: ["database", "postgresql", "mysql"],
    });

    const doc = capabilityToDocument(capability);

    expect(doc.text).toContain("database");
    expect(doc.text).toContain("postgresql");
    expect(doc.text).toContain("mysql");
  });

  it("includes providers in embedding text", () => {
    const capability = makeCapability({
      providers: ["aws", "gcp", "azure"],
    });

    const doc = capabilityToDocument(capability);

    expect(doc.text).toContain("aws");
    expect(doc.text).toContain("gcp");
    expect(doc.text).toContain("azure");
  });

  it("includes description and useCase in embedding text", () => {
    const capability = makeCapability({
      description: "Managed database solution.",
      useCase: "Deploy a managed SQL database.",
    });

    const doc = capabilityToDocument(capability);

    expect(doc.text).toContain("Managed database solution.");
    expect(doc.text).toContain("Deploy a managed SQL database.");
  });

  it("includes complexity in embedding text", () => {
    const capability = makeCapability({ complexity: "high" });

    const doc = capabilityToDocument(capability);

    expect(doc.text).toContain("high");
  });

  it("stores kind in metadata for filtering", () => {
    const capability = makeCapability({ kind: "SQL" });

    const doc = capabilityToDocument(capability);

    expect(doc.metadata.kind).toBe("SQL");
  });

  it("stores apiGroup in metadata for filtering", () => {
    const capability = makeCapability({ group: "devopstoolkit.live" });

    const doc = capabilityToDocument(capability);

    expect(doc.metadata.apiGroup).toBe("devopstoolkit.live");
  });

  it("stores apiVersion in metadata", () => {
    const capability = makeCapability({
      apiVersion: "devopstoolkit.live/v1beta1",
    });

    const doc = capabilityToDocument(capability);

    expect(doc.metadata.apiVersion).toBe("devopstoolkit.live/v1beta1");
  });

  it("stores complexity in metadata for filtering", () => {
    const capability = makeCapability({ complexity: "medium" });

    const doc = capabilityToDocument(capability);

    expect(doc.metadata.complexity).toBe("medium");
  });

  it("stores providers as comma-separated string in metadata", () => {
    const capability = makeCapability({
      providers: ["aws", "gcp", "azure"],
    });

    const doc = capabilityToDocument(capability);

    expect(doc.metadata.providers).toBe("aws,gcp,azure");
  });

  it("stores confidence as a number in metadata", () => {
    const capability = makeCapability({ confidence: 0.85 });

    const doc = capabilityToDocument(capability);

    expect(doc.metadata.confidence).toBe(0.85);
  });

  it("stores resourceName in metadata for cross-referencing", () => {
    const capability = makeCapability({
      resourceName: "sqls.devopstoolkit.live",
    });

    const doc = capabilityToDocument(capability);

    expect(doc.metadata.resourceName).toBe("sqls.devopstoolkit.live");
  });

  it("handles empty capabilities array", () => {
    const capability = makeCapability({ capabilities: [] });

    const doc = capabilityToDocument(capability);

    // Should not crash; text still includes other fields
    expect(doc.id).toBe("sqls.devopstoolkit.live");
    expect(doc.text).toContain("SQL");
  });

  it("handles empty providers array", () => {
    const capability = makeCapability({ providers: [] });

    const doc = capabilityToDocument(capability);

    // Providers metadata should be empty string for empty array
    expect(doc.metadata.providers).toBe("");
  });

  it("handles core resources with empty group", () => {
    const capability = makeCapability({
      resourceName: "configmaps",
      apiVersion: "v1",
      group: "",
      kind: "ConfigMap",
      providers: [],
    });

    const doc = capabilityToDocument(capability);

    expect(doc.id).toBe("configmaps");
    expect(doc.metadata.apiGroup).toBe("");
    expect(doc.text).toContain("ConfigMap");
  });

  it("returns a valid VectorDocument shape", () => {
    const capability = makeCapability();

    const doc = capabilityToDocument(capability);

    // Verify the shape matches VectorDocument interface
    expect(typeof doc.id).toBe("string");
    expect(typeof doc.text).toBe("string");
    expect(typeof doc.metadata).toBe("object");
    expect(doc.id.length).toBeGreaterThan(0);
    expect(doc.text.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// storeCapabilities
// ---------------------------------------------------------------------------

describe("storeCapabilities", () => {
  it("initializes the capabilities collection with cosine distance", async () => {
    const mockStore = createMockVectorStore();

    await storeCapabilities([], mockStore);

    expect(mockStore.initialize).toHaveBeenCalledWith("capabilities", {
      distanceMetric: "cosine",
    });
  });

  it("stores documents in the capabilities collection", async () => {
    const mockStore = createMockVectorStore();
    const capabilities = [
      makeCapability({ resourceName: "sqls.devopstoolkit.live", kind: "SQL" }),
      makeCapability({
        resourceName: "buckets.s3.aws.upbound.io",
        kind: "Bucket",
        group: "s3.aws.upbound.io",
      }),
    ];

    await storeCapabilities(capabilities, mockStore);

    expect(mockStore.store).toHaveBeenCalledOnce();
    const [collection, documents] = mockStore.store.mock.calls[0];
    expect(collection).toBe("capabilities");
    expect(documents).toHaveLength(2);
    expect(documents[0].id).toBe("sqls.devopstoolkit.live");
    expect(documents[1].id).toBe("buckets.s3.aws.upbound.io");
  });

  it("handles empty capabilities array without calling store", async () => {
    const mockStore = createMockVectorStore();

    await storeCapabilities([], mockStore);

    // Should still initialize but not call store
    expect(mockStore.initialize).toHaveBeenCalledOnce();
    expect(mockStore.store).not.toHaveBeenCalled();
  });

  it("reports progress via callback", async () => {
    const mockStore = createMockVectorStore();
    const capabilities = [
      makeCapability({ resourceName: "a.example.com" }),
      makeCapability({ resourceName: "b.example.com" }),
    ];
    const progressMessages: string[] = [];

    await storeCapabilities(capabilities, mockStore, {
      onProgress: (msg) => progressMessages.push(msg),
    });

    // Should report storing and completion
    expect(progressMessages.length).toBeGreaterThanOrEqual(1);
    const hasStoringMessage = progressMessages.some(
      (m) => m.includes("Storing") || m.includes("storing")
    );
    const hasCompleteMessage = progressMessages.some(
      (m) => m.includes("complete") || m.includes("stored")
    );
    expect(hasStoringMessage || hasCompleteMessage).toBe(true);
  });

  it("converts all capabilities to documents before storing", async () => {
    const mockStore = createMockVectorStore();
    const capabilities = [
      makeCapability({
        resourceName: "sqls.devopstoolkit.live",
        kind: "SQL",
        complexity: "low",
      }),
      makeCapability({
        resourceName: "services",
        kind: "Service",
        group: "",
        apiVersion: "v1",
        complexity: "medium",
      }),
    ];

    await storeCapabilities(capabilities, mockStore);

    const documents: VectorDocument[] = mockStore.store.mock.calls[0][1];

    // Verify each document has expected metadata
    expect(documents[0].metadata.kind).toBe("SQL");
    expect(documents[0].metadata.complexity).toBe("low");
    expect(documents[1].metadata.kind).toBe("Service");
    expect(documents[1].metadata.complexity).toBe("medium");
  });
});
