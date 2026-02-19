/**
 * runner.test.ts - Unit tests for the sync pipeline runner (M4)
 *
 * Tests the orchestration that wires M1 (discovery), M2 (inference), and
 * M3 (storage) together into a single sync operation. Mocks the pipeline
 * modules to isolate orchestration logic — each stage has its own tests.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the pipeline modules so we test orchestration, not the stages themselves.
// Each stage has its own comprehensive unit + integration tests.
vi.mock("./discovery", () => ({
  discoverResources: vi.fn(),
}));
vi.mock("./inference", () => ({
  inferCapabilities: vi.fn(),
}));
vi.mock("./storage", () => ({
  storeCapabilities: vi.fn(),
}));

import { syncCapabilities } from "./runner";
import { discoverResources } from "./discovery";
import { inferCapabilities } from "./inference";
import { storeCapabilities } from "./storage";
import type { DiscoveredResource, ResourceCapability } from "./types";
import type { VectorStore } from "../vectorstore";

// ---------------------------------------------------------------------------
// Test fixture helpers
// ---------------------------------------------------------------------------

/**
 * Creates a DiscoveredResource with sensible defaults.
 * Override only the fields relevant to each test case.
 */
function makeResource(
  overrides: Partial<DiscoveredResource> = {}
): DiscoveredResource {
  return {
    name: "sqls.devopstoolkit.live",
    apiVersion: "devopstoolkit.live/v1beta1",
    group: "devopstoolkit.live",
    kind: "SQL",
    namespaced: true,
    isCRD: true,
    schema: "KIND: SQL\nVERSION: devopstoolkit.live/v1beta1\n",
    ...overrides,
  };
}

/**
 * Creates a ResourceCapability with sensible defaults.
 * Override only the fields relevant to each test case.
 */
function makeCapability(
  overrides: Partial<ResourceCapability> = {}
): ResourceCapability {
  return {
    resourceName: "sqls.devopstoolkit.live",
    apiVersion: "devopstoolkit.live/v1beta1",
    group: "devopstoolkit.live",
    kind: "SQL",
    capabilities: ["database", "postgresql"],
    providers: ["aws", "gcp"],
    complexity: "low",
    description: "Managed database solution.",
    useCase: "Deploy a managed SQL database.",
    confidence: 0.9,
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
const mockedDiscover = discoverResources as ReturnType<typeof vi.fn>;
const mockedInfer = inferCapabilities as ReturnType<typeof vi.fn>;
const mockedStore = storeCapabilities as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// syncCapabilities
// ---------------------------------------------------------------------------

describe("syncCapabilities", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: discovery finds 2 resources, inference succeeds for both
    mockedDiscover.mockResolvedValue([
      makeResource({ name: "sqls.devopstoolkit.live", kind: "SQL" }),
      makeResource({ name: "configmaps", kind: "ConfigMap", group: "", isCRD: false }),
    ]);
    mockedInfer.mockResolvedValue([
      makeCapability({ resourceName: "sqls.devopstoolkit.live", kind: "SQL" }),
      makeCapability({ resourceName: "configmaps", kind: "ConfigMap" }),
    ]);
    mockedStore.mockResolvedValue(undefined);
  });

  it("orchestrates discover -> infer -> store in sequence", async () => {
    const mockVectorStore = createMockVectorStore();
    const callOrder: string[] = [];

    mockedDiscover.mockImplementation(async () => {
      callOrder.push("discover");
      return [makeResource()];
    });
    mockedInfer.mockImplementation(async () => {
      callOrder.push("infer");
      return [makeCapability()];
    });
    mockedStore.mockImplementation(async () => {
      callOrder.push("store");
    });

    await syncCapabilities({ vectorStore: mockVectorStore, onProgress: () => {} });

    expect(callOrder).toEqual(["discover", "infer", "store"]);
  });

  it("passes discovered resources to the inference stage", async () => {
    const resources = [
      makeResource({ name: "sqls.devopstoolkit.live" }),
      makeResource({ name: "buckets.s3.aws.upbound.io" }),
    ];
    mockedDiscover.mockResolvedValue(resources);
    mockedInfer.mockResolvedValue([makeCapability()]);
    const mockVectorStore = createMockVectorStore();

    await syncCapabilities({ vectorStore: mockVectorStore, onProgress: () => {} });

    // inferCapabilities receives the discovered resources as first argument
    expect(mockedInfer).toHaveBeenCalledOnce();
    expect(mockedInfer.mock.calls[0][0]).toBe(resources);
  });

  it("passes inferred capabilities and vectorStore to the storage stage", async () => {
    const capabilities = [
      makeCapability({ resourceName: "sqls.devopstoolkit.live" }),
    ];
    mockedDiscover.mockResolvedValue([makeResource()]);
    mockedInfer.mockResolvedValue(capabilities);
    const mockVectorStore = createMockVectorStore();

    await syncCapabilities({ vectorStore: mockVectorStore, onProgress: () => {} });

    expect(mockedStore).toHaveBeenCalledOnce();
    expect(mockedStore.mock.calls[0][0]).toBe(capabilities);
    expect(mockedStore.mock.calls[0][1]).toBe(mockVectorStore);
  });

  it("returns SyncResult with correct counts", async () => {
    mockedDiscover.mockResolvedValue([
      makeResource({ name: "a.example.com" }),
      makeResource({ name: "b.example.com" }),
      makeResource({ name: "c.example.com" }),
    ]);
    mockedInfer.mockResolvedValue([
      makeCapability({ resourceName: "a.example.com" }),
      makeCapability({ resourceName: "c.example.com" }),
      // b.example.com was skipped by inference (failure)
    ]);
    const mockVectorStore = createMockVectorStore();

    const result = await syncCapabilities({
      vectorStore: mockVectorStore,
      onProgress: () => {},
    });

    expect(result.discovered).toBe(3);
    expect(result.inferred).toBe(2);
    expect(result.stored).toBe(2);
  });

  it("skips storage when dryRun is true", async () => {
    mockedDiscover.mockResolvedValue([makeResource()]);
    mockedInfer.mockResolvedValue([makeCapability()]);
    const mockVectorStore = createMockVectorStore();

    const result = await syncCapabilities({
      vectorStore: mockVectorStore,
      dryRun: true,
      onProgress: () => {},
    });

    expect(mockedStore).not.toHaveBeenCalled();
    expect(result.stored).toBe(0);
    // Discovery and inference still run
    expect(result.discovered).toBe(1);
    expect(result.inferred).toBe(1);
  });

  it("reports progress including a sync summary", async () => {
    mockedDiscover.mockResolvedValue([makeResource(), makeResource()]);
    mockedInfer.mockResolvedValue([makeCapability()]);
    const mockVectorStore = createMockVectorStore();
    const progressMessages: string[] = [];

    await syncCapabilities({
      vectorStore: mockVectorStore,
      onProgress: (msg) => progressMessages.push(msg),
    });

    // Should have a summary message at the end
    const summary = progressMessages[progressMessages.length - 1];
    expect(summary).toContain("Sync complete");
    expect(summary).toContain("2 discovered");
    expect(summary).toContain("1 inferred");
    expect(summary).toContain("1 stored");
  });

  it("reports dry run in progress messages", async () => {
    mockedDiscover.mockResolvedValue([makeResource()]);
    mockedInfer.mockResolvedValue([makeCapability()]);
    const mockVectorStore = createMockVectorStore();
    const progressMessages: string[] = [];

    await syncCapabilities({
      vectorStore: mockVectorStore,
      dryRun: true,
      onProgress: (msg) => progressMessages.push(msg),
    });

    const dryRunMessage = progressMessages.find((m) =>
      m.toLowerCase().includes("dry run")
    );
    expect(dryRunMessage).toBeDefined();
  });

  it("forwards discoveryOptions to discoverResources", async () => {
    const customKubectl = vi.fn().mockReturnValue({ output: "", isError: true });
    mockedDiscover.mockResolvedValue([]);
    mockedInfer.mockResolvedValue([]);
    const mockVectorStore = createMockVectorStore();

    await syncCapabilities({
      vectorStore: mockVectorStore,
      discoveryOptions: { kubectl: customKubectl },
      onProgress: () => {},
    });

    // The discoveryOptions should be forwarded (merged with onProgress)
    const discoveryArg = mockedDiscover.mock.calls[0][0];
    expect(discoveryArg.kubectl).toBe(customKubectl);
  });

  it("forwards inferenceOptions to inferCapabilities", async () => {
    const customModel = { invoke: vi.fn() };
    mockedDiscover.mockResolvedValue([makeResource()]);
    mockedInfer.mockResolvedValue([]);
    const mockVectorStore = createMockVectorStore();

    await syncCapabilities({
      vectorStore: mockVectorStore,
      inferenceOptions: { model: customModel },
      onProgress: () => {},
    });

    // The inferenceOptions should be forwarded (merged with onProgress)
    const inferenceArg = mockedInfer.mock.calls[0][1];
    expect(inferenceArg.model).toBe(customModel);
  });

  it("handles zero discovered resources gracefully", async () => {
    mockedDiscover.mockResolvedValue([]);
    mockedInfer.mockResolvedValue([]);
    const mockVectorStore = createMockVectorStore();

    const result = await syncCapabilities({
      vectorStore: mockVectorStore,
      onProgress: () => {},
    });

    expect(result.discovered).toBe(0);
    expect(result.inferred).toBe(0);
    expect(result.stored).toBe(0);
    // inferCapabilities still called with empty array (it handles that)
    expect(mockedInfer).toHaveBeenCalledOnce();
    // storeCapabilities still called (it handles empty array)
    expect(mockedStore).toHaveBeenCalledOnce();
  });

  it("propagates discovery errors to the caller", async () => {
    mockedDiscover.mockRejectedValue(
      new Error("kubectl not found")
    );
    const mockVectorStore = createMockVectorStore();

    await expect(
      syncCapabilities({ vectorStore: mockVectorStore, onProgress: () => {} })
    ).rejects.toThrow("kubectl not found");
  });

  it("passes onProgress to all three pipeline stages", async () => {
    const mockVectorStore = createMockVectorStore();
    const onProgress = vi.fn();
    mockedDiscover.mockResolvedValue([]);
    mockedInfer.mockResolvedValue([]);

    await syncCapabilities({ vectorStore: mockVectorStore, onProgress });

    // Each stage should receive onProgress in its options
    const discoveryOpts = mockedDiscover.mock.calls[0][0];
    expect(discoveryOpts.onProgress).toBe(onProgress);

    const inferenceOpts = mockedInfer.mock.calls[0][1];
    expect(inferenceOpts.onProgress).toBe(onProgress);

    const storageOpts = mockedStore.mock.calls[0][2];
    expect(storageOpts.onProgress).toBe(onProgress);
  });
});
