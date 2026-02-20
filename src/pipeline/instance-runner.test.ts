/**
 * instance-runner.test.ts - Unit tests for the instance sync runner (PRD #26 M3)
 *
 * Tests the orchestration that wires M1 (instance discovery) and M2 (instance
 * storage) together into a single sync operation, including stale document
 * cleanup. Mocks the pipeline modules to isolate orchestration logic — each
 * stage has its own comprehensive unit + integration tests.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the pipeline modules so we test orchestration, not the stages themselves.
vi.mock("./instance-discovery", () => ({
  discoverInstances: vi.fn(),
}));
vi.mock("./instance-storage", () => ({
  storeInstances: vi.fn(),
}));

import { syncInstances } from "./instance-runner";
import { discoverInstances } from "./instance-discovery";
import { storeInstances } from "./instance-storage";
import type { ResourceInstance } from "./types";
import type { VectorStore } from "../vectorstore";

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
    labels: { app: "nginx" },
    annotations: {},
    createdAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

/**
 * Creates a mock VectorStore with all methods stubbed.
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

// Cast the mocked functions for easy access in tests
const mockedDiscover = discoverInstances as ReturnType<typeof vi.fn>;
const mockedStore = storeInstances as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// syncInstances
// ---------------------------------------------------------------------------

describe("syncInstances", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: discovery finds 2 instances, store succeeds
    mockedDiscover.mockResolvedValue([
      makeInstance({ id: "default/apps/v1/Deployment/nginx", name: "nginx" }),
      makeInstance({
        id: "default/v1/Service/nginx-svc",
        name: "nginx-svc",
        kind: "Service",
        apiVersion: "v1",
        apiGroup: "",
      }),
    ]);
    mockedStore.mockResolvedValue(undefined);
  });

  it("orchestrates discover -> delete stale -> store in sequence", async () => {
    const mockVectorStore = createMockVectorStore();
    // Simulate one existing doc that's no longer in the cluster
    mockVectorStore.keywordSearch.mockResolvedValue([
      { id: "default/apps/v1/Deployment/old-app", text: "", metadata: {}, score: -1 },
    ]);
    const callOrder: string[] = [];

    mockedDiscover.mockImplementation(async () => {
      callOrder.push("discover");
      return [makeInstance()];
    });
    mockedStore.mockImplementation(async () => {
      callOrder.push("store");
    });
    // Track delete calls via the vectorStore mock
    mockVectorStore.delete.mockImplementation(async () => {
      callOrder.push("delete");
    });

    await syncInstances({ vectorStore: mockVectorStore, onProgress: () => {} });

    expect(callOrder).toEqual(["discover", "delete", "store"]);
  });

  it("passes discovered instances to the storage stage", async () => {
    const instances = [
      makeInstance({ id: "default/apps/v1/Deployment/nginx" }),
      makeInstance({ id: "default/v1/Service/redis" }),
    ];
    mockedDiscover.mockResolvedValue(instances);
    const mockVectorStore = createMockVectorStore();

    await syncInstances({ vectorStore: mockVectorStore, onProgress: () => {} });

    expect(mockedStore).toHaveBeenCalledOnce();
    expect(mockedStore.mock.calls[0][0]).toBe(instances);
    expect(mockedStore.mock.calls[0][1]).toBe(mockVectorStore);
  });

  it("returns SyncInstancesResult with correct counts", async () => {
    mockedDiscover.mockResolvedValue([
      makeInstance({ id: "default/apps/v1/Deployment/a" }),
      makeInstance({ id: "default/apps/v1/Deployment/b" }),
      makeInstance({ id: "default/apps/v1/Deployment/c" }),
    ]);
    const mockVectorStore = createMockVectorStore();

    const result = await syncInstances({
      vectorStore: mockVectorStore,
      onProgress: () => {},
    });

    expect(result.discovered).toBe(3);
    expect(result.stored).toBe(3);
    expect(result.deleted).toBe(0);
  });

  it("skips storage and delete when dryRun is true", async () => {
    mockedDiscover.mockResolvedValue([makeInstance()]);
    const mockVectorStore = createMockVectorStore();
    mockVectorStore.keywordSearch.mockResolvedValue([
      { id: "stale-id", text: "", metadata: {}, score: -1 },
    ]);

    const result = await syncInstances({
      vectorStore: mockVectorStore,
      dryRun: true,
      onProgress: () => {},
    });

    expect(mockedStore).not.toHaveBeenCalled();
    expect(mockVectorStore.keywordSearch).not.toHaveBeenCalled();
    expect(mockVectorStore.delete).not.toHaveBeenCalled();
    expect(result.stored).toBe(0);
    expect(result.deleted).toBe(0);
    // Discovery still runs
    expect(result.discovered).toBe(1);
  });

  it("reports progress including a sync summary", async () => {
    mockedDiscover.mockResolvedValue([makeInstance(), makeInstance()]);
    const mockVectorStore = createMockVectorStore();
    const progressMessages: string[] = [];

    await syncInstances({
      vectorStore: mockVectorStore,
      onProgress: (msg) => progressMessages.push(msg),
    });

    const summary = progressMessages[progressMessages.length - 1];
    expect(summary).toContain("Sync complete");
    expect(summary).toContain("2 discovered");
    expect(summary).toContain("2 stored");
    expect(summary).toContain("0 deleted");
  });

  it("reports dry run in progress messages", async () => {
    mockedDiscover.mockResolvedValue([makeInstance()]);
    const mockVectorStore = createMockVectorStore();
    const progressMessages: string[] = [];

    await syncInstances({
      vectorStore: mockVectorStore,
      dryRun: true,
      onProgress: (msg) => progressMessages.push(msg),
    });

    const dryRunMessage = progressMessages.find((m) =>
      m.toLowerCase().includes("dry run")
    );
    expect(dryRunMessage).toBeDefined();
  });

  it("forwards discoveryOptions to discoverInstances", async () => {
    const customKubectl = vi.fn().mockReturnValue({ output: "", isError: true });
    mockedDiscover.mockResolvedValue([]);
    const mockVectorStore = createMockVectorStore();

    await syncInstances({
      vectorStore: mockVectorStore,
      discoveryOptions: { kubectl: customKubectl },
      onProgress: () => {},
    });

    const discoveryArg = mockedDiscover.mock.calls[0][0];
    expect(discoveryArg.kubectl).toBe(customKubectl);
  });

  it("forwards onProgress to discovery and storage stages", async () => {
    const mockVectorStore = createMockVectorStore();
    const onProgress = vi.fn();
    mockedDiscover.mockResolvedValue([]);

    await syncInstances({ vectorStore: mockVectorStore, onProgress });

    // Discovery receives onProgress
    const discoveryOpts = mockedDiscover.mock.calls[0][0];
    expect(discoveryOpts.onProgress).toBe(onProgress);

    // Storage receives onProgress
    const storageOpts = mockedStore.mock.calls[0][2];
    expect(storageOpts.onProgress).toBe(onProgress);
  });

  it("handles zero discovered instances gracefully", async () => {
    mockedDiscover.mockResolvedValue([]);
    const mockVectorStore = createMockVectorStore();

    const result = await syncInstances({
      vectorStore: mockVectorStore,
      onProgress: () => {},
    });

    expect(result.discovered).toBe(0);
    expect(result.stored).toBe(0);
    expect(result.deleted).toBe(0);
    // storeInstances still called (it handles empty arrays)
    expect(mockedStore).toHaveBeenCalledOnce();
  });

  it("propagates discovery errors to the caller", async () => {
    mockedDiscover.mockRejectedValue(new Error("kubectl not found"));
    const mockVectorStore = createMockVectorStore();

    await expect(
      syncInstances({ vectorStore: mockVectorStore, onProgress: () => {} })
    ).rejects.toThrow("kubectl not found");
  });

  // ---------------------------------------------------------------------------
  // Stale document deletion
  // ---------------------------------------------------------------------------

  describe("stale document deletion", () => {
    it("deletes documents that exist in the DB but not in the cluster", async () => {
      // Cluster has only nginx
      mockedDiscover.mockResolvedValue([
        makeInstance({ id: "default/apps/v1/Deployment/nginx" }),
      ]);
      const mockVectorStore = createMockVectorStore();
      // DB has nginx AND an old-app that no longer exists
      mockVectorStore.keywordSearch.mockResolvedValue([
        { id: "default/apps/v1/Deployment/nginx", text: "", metadata: {}, score: -1 },
        { id: "default/apps/v1/Deployment/old-app", text: "", metadata: {}, score: -1 },
      ]);

      const result = await syncInstances({
        vectorStore: mockVectorStore,
        onProgress: () => {},
      });

      expect(mockVectorStore.delete).toHaveBeenCalledWith(
        "instances",
        ["default/apps/v1/Deployment/old-app"]
      );
      expect(result.deleted).toBe(1);
    });

    it("does not delete when all DB documents are still in the cluster", async () => {
      const instances = [
        makeInstance({ id: "default/apps/v1/Deployment/nginx" }),
        makeInstance({ id: "default/v1/Service/redis" }),
      ];
      mockedDiscover.mockResolvedValue(instances);
      const mockVectorStore = createMockVectorStore();
      mockVectorStore.keywordSearch.mockResolvedValue([
        { id: "default/apps/v1/Deployment/nginx", text: "", metadata: {}, score: -1 },
        { id: "default/v1/Service/redis", text: "", metadata: {}, score: -1 },
      ]);

      const result = await syncInstances({
        vectorStore: mockVectorStore,
        onProgress: () => {},
      });

      expect(mockVectorStore.delete).not.toHaveBeenCalled();
      expect(result.deleted).toBe(0);
    });

    it("handles empty DB gracefully (first sync)", async () => {
      mockedDiscover.mockResolvedValue([makeInstance()]);
      const mockVectorStore = createMockVectorStore();
      // No existing documents in DB
      mockVectorStore.keywordSearch.mockResolvedValue([]);

      const result = await syncInstances({
        vectorStore: mockVectorStore,
        onProgress: () => {},
      });

      expect(mockVectorStore.delete).not.toHaveBeenCalled();
      expect(result.deleted).toBe(0);
    });

    it("deletes all DB documents when cluster is empty", async () => {
      mockedDiscover.mockResolvedValue([]);
      const mockVectorStore = createMockVectorStore();
      mockVectorStore.keywordSearch.mockResolvedValue([
        { id: "default/apps/v1/Deployment/old-1", text: "", metadata: {}, score: -1 },
        { id: "default/apps/v1/Deployment/old-2", text: "", metadata: {}, score: -1 },
      ]);

      const result = await syncInstances({
        vectorStore: mockVectorStore,
        onProgress: () => {},
      });

      expect(mockVectorStore.delete).toHaveBeenCalledWith(
        "instances",
        ["default/apps/v1/Deployment/old-1", "default/apps/v1/Deployment/old-2"]
      );
      expect(result.deleted).toBe(2);
    });

    it("reports stale deletion in progress messages", async () => {
      mockedDiscover.mockResolvedValue([]);
      const mockVectorStore = createMockVectorStore();
      mockVectorStore.keywordSearch.mockResolvedValue([
        { id: "stale-1", text: "", metadata: {}, score: -1 },
        { id: "stale-2", text: "", metadata: {}, score: -1 },
        { id: "stale-3", text: "", metadata: {}, score: -1 },
      ]);
      const progressMessages: string[] = [];

      await syncInstances({
        vectorStore: mockVectorStore,
        onProgress: (msg) => progressMessages.push(msg),
      });

      const deleteMsg = progressMessages.find((m) =>
        m.includes("3") && m.toLowerCase().includes("stale")
      );
      expect(deleteMsg).toBeDefined();
    });

    it("queries existing documents from the instances collection", async () => {
      mockedDiscover.mockResolvedValue([makeInstance()]);
      const mockVectorStore = createMockVectorStore();

      await syncInstances({
        vectorStore: mockVectorStore,
        onProgress: () => {},
      });

      // Should query the instances collection with a high nResults limit
      expect(mockVectorStore.keywordSearch).toHaveBeenCalledWith(
        "instances",
        undefined,
        expect.objectContaining({ nResults: expect.any(Number) })
      );
    });
  });
});
