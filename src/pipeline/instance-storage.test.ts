/**
 * instance-storage.test.ts - Unit tests for vector storage of resource instances (PRD #26 M2)
 *
 * Tests the mapping from ResourceInstance to VectorDocument and the
 * orchestration of storing instances in the vector database. Uses a
 * mock VectorStore at the system boundary — no Chroma or Voyage AI needed.
 */

import { describe, it, expect, vi } from "vitest";
import { instanceToDocument, storeInstances } from "./instance-storage";
import type { ResourceInstance } from "./types";
import type { VectorStore, VectorDocument } from "../vectorstore";

// ---------------------------------------------------------------------------
// Test fixture helpers
// ---------------------------------------------------------------------------

/**
 * Creates a ResourceInstance with sensible defaults.
 * Override the specific fields relevant to each test case.
 */
function makeInstance(
  overrides: Partial<ResourceInstance> = {}
): ResourceInstance {
  return {
    id: "default/apps/v1/Deployment/nginx",
    namespace: "default",
    name: "nginx",
    kind: "Deployment",
    apiVersion: "apps/v1",
    apiGroup: "apps",
    labels: { app: "nginx", tier: "frontend" },
    annotations: {},
    createdAt: "2026-01-15T10:30:00Z",
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
// instanceToDocument
// ---------------------------------------------------------------------------

describe("instanceToDocument", () => {
  it("uses instance id as the document id", () => {
    const instance = makeInstance({
      id: "default/apps/v1/Deployment/nginx",
    });

    const doc = instanceToDocument(instance);

    expect(doc.id).toBe("default/apps/v1/Deployment/nginx");
  });

  it("includes kind and name in embedding text", () => {
    const instance = makeInstance({ kind: "Deployment", name: "nginx" });

    const doc = instanceToDocument(instance);

    expect(doc.text).toContain("Deployment");
    expect(doc.text).toContain("nginx");
  });

  it("includes namespace in embedding text", () => {
    const instance = makeInstance({ namespace: "production" });

    const doc = instanceToDocument(instance);

    expect(doc.text).toContain("production");
  });

  it("includes apiVersion in embedding text", () => {
    const instance = makeInstance({ apiVersion: "apps/v1" });

    const doc = instanceToDocument(instance);

    expect(doc.text).toContain("apps/v1");
  });

  it("includes labels as key=value pairs in embedding text", () => {
    const instance = makeInstance({
      labels: { app: "nginx", tier: "frontend" },
    });

    const doc = instanceToDocument(instance);

    expect(doc.text).toContain("app=nginx");
    expect(doc.text).toContain("tier=frontend");
  });

  it("includes description annotations in embedding text", () => {
    const instance = makeInstance({
      annotations: { description: "A web server for handling HTTP traffic" },
    });

    const doc = instanceToDocument(instance);

    expect(doc.text).toContain("A web server for handling HTTP traffic");
  });

  it("handles empty labels", () => {
    const instance = makeInstance({ labels: {} });

    const doc = instanceToDocument(instance);

    // Should not crash; text still includes kind, name, namespace
    expect(doc.text).toContain("Deployment");
    expect(doc.text).toContain("nginx");
  });

  it("handles empty annotations", () => {
    const instance = makeInstance({ annotations: {} });

    const doc = instanceToDocument(instance);

    // Should not crash; text still includes other fields
    expect(doc.id).toBe("default/apps/v1/Deployment/nginx");
    expect(doc.text).toContain("Deployment");
  });

  it("handles cluster-scoped resources with _cluster namespace", () => {
    const instance = makeInstance({
      id: "_cluster/v1/Namespace/kube-system",
      namespace: "_cluster",
      name: "kube-system",
      kind: "Namespace",
      apiVersion: "v1",
      apiGroup: "",
    });

    const doc = instanceToDocument(instance);

    expect(doc.id).toBe("_cluster/v1/Namespace/kube-system");
    expect(doc.text).toContain("Namespace");
    expect(doc.text).toContain("kube-system");
  });

  // --- Metadata tests ---

  it("stores namespace in metadata for filtering", () => {
    const instance = makeInstance({ namespace: "production" });

    const doc = instanceToDocument(instance);

    expect(doc.metadata.namespace).toBe("production");
  });

  it("stores name in metadata", () => {
    const instance = makeInstance({ name: "nginx" });

    const doc = instanceToDocument(instance);

    expect(doc.metadata.name).toBe("nginx");
  });

  it("stores kind in metadata for filtering", () => {
    const instance = makeInstance({ kind: "Deployment" });

    const doc = instanceToDocument(instance);

    expect(doc.metadata.kind).toBe("Deployment");
  });

  it("stores apiVersion in metadata", () => {
    const instance = makeInstance({ apiVersion: "apps/v1" });

    const doc = instanceToDocument(instance);

    expect(doc.metadata.apiVersion).toBe("apps/v1");
  });

  it("stores apiGroup in metadata for filtering", () => {
    const instance = makeInstance({ apiGroup: "apps" });

    const doc = instanceToDocument(instance);

    expect(doc.metadata.apiGroup).toBe("apps");
  });

  it("stores labels as comma-separated key=value string in metadata", () => {
    const instance = makeInstance({
      labels: { app: "nginx", tier: "frontend" },
    });

    const doc = instanceToDocument(instance);

    // Labels are flat comma-separated string (same pattern as capabilities providers)
    const labelsStr = doc.metadata.labels as string;
    expect(labelsStr).toContain("app=nginx");
    expect(labelsStr).toContain("tier=frontend");
  });

  it("stores empty string for empty labels in metadata", () => {
    const instance = makeInstance({ labels: {} });

    const doc = instanceToDocument(instance);

    expect(doc.metadata.labels).toBe("");
  });

  it("stores source as 'resource-sync' in metadata", () => {
    const instance = makeInstance();

    const doc = instanceToDocument(instance);

    expect(doc.metadata.source).toBe("resource-sync");
  });

  it("handles core resources with empty apiGroup", () => {
    const instance = makeInstance({
      id: "default/v1/Service/kubernetes",
      kind: "Service",
      name: "kubernetes",
      apiVersion: "v1",
      apiGroup: "",
    });

    const doc = instanceToDocument(instance);

    expect(doc.metadata.apiGroup).toBe("");
    expect(doc.text).toContain("Service");
    expect(doc.text).toContain("kubernetes");
  });

  it("returns a valid VectorDocument shape", () => {
    const instance = makeInstance();

    const doc = instanceToDocument(instance);

    expect(typeof doc.id).toBe("string");
    expect(typeof doc.text).toBe("string");
    expect(typeof doc.metadata).toBe("object");
    expect(doc.id.length).toBeGreaterThan(0);
    expect(doc.text.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// storeInstances
// ---------------------------------------------------------------------------

describe("storeInstances", () => {
  it("initializes the instances collection with cosine distance", async () => {
    const mockStore = createMockVectorStore();

    await storeInstances([], mockStore);

    expect(mockStore.initialize).toHaveBeenCalledWith("instances", {
      distanceMetric: "cosine",
    });
  });

  it("stores documents in the instances collection", async () => {
    const mockStore = createMockVectorStore();
    const instances = [
      makeInstance({
        id: "default/apps/v1/Deployment/nginx",
        name: "nginx",
        kind: "Deployment",
      }),
      makeInstance({
        id: "default/v1/Service/redis",
        name: "redis",
        kind: "Service",
        apiVersion: "v1",
        apiGroup: "",
      }),
    ];

    await storeInstances(instances, mockStore);

    expect(mockStore.store).toHaveBeenCalledOnce();
    const [collection, documents] = mockStore.store.mock.calls[0];
    expect(collection).toBe("instances");
    expect(documents).toHaveLength(2);
    expect(documents[0].id).toBe("default/apps/v1/Deployment/nginx");
    expect(documents[1].id).toBe("default/v1/Service/redis");
  });

  it("handles empty instances array without calling store", async () => {
    const mockStore = createMockVectorStore();

    await storeInstances([], mockStore);

    // Should still initialize but not call store
    expect(mockStore.initialize).toHaveBeenCalledOnce();
    expect(mockStore.store).not.toHaveBeenCalled();
  });

  it("reports progress via callback", async () => {
    const mockStore = createMockVectorStore();
    const instances = [
      makeInstance({ id: "default/apps/v1/Deployment/a" }),
      makeInstance({ id: "default/apps/v1/Deployment/b" }),
    ];
    const progressMessages: string[] = [];

    await storeInstances(instances, mockStore, {
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

  it("converts all instances to documents before storing", async () => {
    const mockStore = createMockVectorStore();
    const instances = [
      makeInstance({
        id: "default/apps/v1/Deployment/nginx",
        kind: "Deployment",
        namespace: "default",
      }),
      makeInstance({
        id: "production/v1/Service/api",
        kind: "Service",
        namespace: "production",
        apiVersion: "v1",
        apiGroup: "",
      }),
    ];

    await storeInstances(instances, mockStore);

    const documents: VectorDocument[] = mockStore.store.mock.calls[0][1];

    // Verify each document has expected metadata
    expect(documents[0].metadata.kind).toBe("Deployment");
    expect(documents[0].metadata.namespace).toBe("default");
    expect(documents[1].metadata.kind).toBe("Service");
    expect(documents[1].metadata.namespace).toBe("production");
  });
});
