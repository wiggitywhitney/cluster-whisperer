// ABOUTME: OTel span tests for kubectl-apply core tool
// ABOUTME: Verifies span creation, attributes, and error status using InMemorySpanExporter

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { trace, SpanKind, SpanStatusCode, context } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-node";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-node";
import type { VectorStore, SearchResult } from "../../vectorstore";

// ---------------------------------------------------------------------------
// Mock child_process
// ---------------------------------------------------------------------------

const mockSpawnSync = vi.fn();
vi.mock("child_process", () => ({
  spawnSync: (...args: unknown[]) => mockSpawnSync(...args),
}));

// ---------------------------------------------------------------------------
// OTel test infrastructure
// ---------------------------------------------------------------------------

let exporter: InMemorySpanExporter;
let provider: BasicTracerProvider;

beforeEach(() => {
  exporter = new InMemorySpanExporter();
  provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  trace.setGlobalTracerProvider(provider);
  mockSpawnSync.mockReset();
});

afterEach(async () => {
  await provider.shutdown();
  trace.disable();
  context.disable();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getSpans(): ReadableSpan[] {
  return exporter.getFinishedSpans();
}

function getSpanByName(name: string): ReadableSpan | undefined {
  return getSpans().find((s) => s.name === name);
}

function createMockVectorStore(overrides?: Partial<VectorStore>): VectorStore {
  return {
    initialize: vi.fn().mockResolvedValue(undefined),
    store: vi.fn().mockResolvedValue(undefined),
    search: vi.fn().mockResolvedValue([]),
    keywordSearch: vi.fn().mockResolvedValue([]),
    delete: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makeCatalogEntry(kind: string, apiGroup: string): SearchResult {
  return {
    id: `${apiGroup}/${kind}`,
    text: `${kind} resource`,
    metadata: { kind, apiGroup },
    score: -1,
  };
}

// Platform CRD — used for successful apply and execution failure tests.
const managedServiceManifest = [
  "apiVersion: platform.acme.io/v1alpha1",
  "kind: ManagedService",
  "metadata:",
  "  name: youchoose-db",
].join("\n");

// Unknown CRD — not built-in, not in catalog.
// Used for catalog rejection and vectorStore failure tests so they reach the
// catalog query path (built-in resources are blocked before that).
const unknownCrdManifest = [
  "apiVersion: widgets.example.com/v1beta1",
  "kind: Widget",
  "metadata:",
  "  name: my-widget",
].join("\n");

// Import after mocks
const { kubectlApply } = await import("./kubectl-apply");

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("kubectl-apply OTel spans", () => {
  describe("successful apply", () => {
    it("creates a span named 'kubectl apply'", async () => {
      const vectorStore = createMockVectorStore({
        keywordSearch: vi.fn().mockResolvedValue([
          makeCatalogEntry("ManagedService", "platform.acme.io"),
        ]),
      });
      mockSpawnSync.mockReturnValue({
        stdout: "created", stderr: "", status: 0, error: null,
      });

      await kubectlApply(vectorStore, { manifest: managedServiceManifest });

      const span = getSpanByName("kubectl apply");
      expect(span).toBeDefined();
    });

    it("sets span kind to CLIENT", async () => {
      const vectorStore = createMockVectorStore({
        keywordSearch: vi.fn().mockResolvedValue([
          makeCatalogEntry("ManagedService", "platform.acme.io"),
        ]),
      });
      mockSpawnSync.mockReturnValue({
        stdout: "created", stderr: "", status: 0, error: null,
      });

      await kubectlApply(vectorStore, { manifest: managedServiceManifest });

      const span = getSpanByName("kubectl apply")!;
      expect(span.kind).toBe(SpanKind.CLIENT);
    });

    it("sets resource kind and api group attributes", async () => {
      const vectorStore = createMockVectorStore({
        keywordSearch: vi.fn().mockResolvedValue([
          makeCatalogEntry("ManagedService", "platform.acme.io"),
        ]),
      });
      mockSpawnSync.mockReturnValue({
        stdout: "created", stderr: "", status: 0, error: null,
      });

      await kubectlApply(vectorStore, { manifest: managedServiceManifest });

      const span = getSpanByName("kubectl apply")!;
      expect(span.attributes["cluster_whisperer.k8s.resource_kind"]).toBe("ManagedService");
      expect(span.attributes["cluster_whisperer.k8s.api_group"]).toBe("platform.acme.io");
    });

    it("sets catalog approved attribute to true", async () => {
      const vectorStore = createMockVectorStore({
        keywordSearch: vi.fn().mockResolvedValue([
          makeCatalogEntry("ManagedService", "platform.acme.io"),
        ]),
      });
      mockSpawnSync.mockReturnValue({
        stdout: "created", stderr: "", status: 0, error: null,
      });

      await kubectlApply(vectorStore, { manifest: managedServiceManifest });

      const span = getSpanByName("kubectl apply")!;
      expect(span.attributes["cluster_whisperer.catalog.approved"]).toBe(true);
    });

    it("sets process attributes on success", async () => {
      const vectorStore = createMockVectorStore({
        keywordSearch: vi.fn().mockResolvedValue([
          makeCatalogEntry("ManagedService", "platform.acme.io"),
        ]),
      });
      mockSpawnSync.mockReturnValue({
        stdout: "managedservice.platform.acme.io/youchoose-db created", stderr: "", status: 0, error: null,
      });

      await kubectlApply(vectorStore, { manifest: managedServiceManifest });

      const span = getSpanByName("kubectl apply")!;
      expect(span.attributes["process.executable.name"]).toBe("kubectl");
      expect(span.attributes["process.exit.code"]).toBe(0);
      expect(span.status.code).toBe(SpanStatusCode.OK);
    });

    it("sets output size attribute", async () => {
      const output = "managedservice.platform.acme.io/youchoose-db created\n";
      const vectorStore = createMockVectorStore({
        keywordSearch: vi.fn().mockResolvedValue([
          makeCatalogEntry("ManagedService", "platform.acme.io"),
        ]),
      });
      mockSpawnSync.mockReturnValue({
        stdout: output, stderr: "", status: 0, error: null,
      });

      await kubectlApply(vectorStore, { manifest: managedServiceManifest });

      const span = getSpanByName("kubectl apply")!;
      expect(span.attributes["cluster_whisperer.k8s.output_size_bytes"]).toBe(
        Buffer.byteLength(output, "utf-8")
      );
    });
  });

  describe("built-in resource rejection", () => {
    it("sets error status and BuiltInResourceRejection type", async () => {
      const vectorStore = createMockVectorStore({
        keywordSearch: vi.fn().mockResolvedValue([]),
      });
      const builtInManifest = [
        "apiVersion: apps/v1",
        "kind: Deployment",
        "metadata:",
        "  name: nginx",
      ].join("\n");

      await kubectlApply(vectorStore, { manifest: builtInManifest });

      const span = getSpanByName("kubectl apply")!;
      expect(span.status.code).toBe(SpanStatusCode.ERROR);
      expect(span.attributes["error.type"]).toBe("BuiltInResourceRejection");
    });
  });

  describe("catalog rejection", () => {
    it("sets catalog approved attribute to false", async () => {
      const vectorStore = createMockVectorStore({
        keywordSearch: vi.fn().mockResolvedValue([]),
      });

      await kubectlApply(vectorStore, { manifest: unknownCrdManifest });

      const span = getSpanByName("kubectl apply")!;
      expect(span.attributes["cluster_whisperer.catalog.approved"]).toBe(false);
    });

    it("sets error status for catalog rejection", async () => {
      const vectorStore = createMockVectorStore({
        keywordSearch: vi.fn().mockResolvedValue([]),
      });

      await kubectlApply(vectorStore, { manifest: unknownCrdManifest });

      const span = getSpanByName("kubectl apply")!;
      expect(span.status.code).toBe(SpanStatusCode.ERROR);
      expect(span.attributes["error.type"]).toBe("CatalogRejection");
    });
  });

  describe("YAML parse error", () => {
    it("sets error status for invalid YAML", async () => {
      const vectorStore = createMockVectorStore();

      await kubectlApply(vectorStore, { manifest: "not: valid: {{{" });

      const span = getSpanByName("kubectl apply")!;
      expect(span.status.code).toBe(SpanStatusCode.ERROR);
      expect(span.attributes["error.type"]).toBe("YAMLParseError");
    });
  });

  describe("kubectl execution failure", () => {
    it("sets error status when kubectl returns non-zero exit", async () => {
      const vectorStore = createMockVectorStore({
        keywordSearch: vi.fn().mockResolvedValue([
          makeCatalogEntry("ManagedService", "platform.acme.io"),
        ]),
      });
      mockSpawnSync.mockReturnValue({
        stdout: "", stderr: "error: connection refused", status: 1, error: null,
      });

      await kubectlApply(vectorStore, { manifest: managedServiceManifest });

      const span = getSpanByName("kubectl apply")!;
      expect(span.status.code).toBe(SpanStatusCode.ERROR);
      expect(span.attributes["process.exit.code"]).toBe(1);
    });

    it("records exception when kubectl spawn fails", async () => {
      const vectorStore = createMockVectorStore({
        keywordSearch: vi.fn().mockResolvedValue([
          makeCatalogEntry("ManagedService", "platform.acme.io"),
        ]),
      });
      mockSpawnSync.mockReturnValue({
        stdout: "", stderr: "", status: null, error: new Error("ENOENT"),
      });

      await kubectlApply(vectorStore, { manifest: managedServiceManifest });

      const span = getSpanByName("kubectl apply")!;
      expect(span.status.code).toBe(SpanStatusCode.ERROR);
      expect(span.events.length).toBeGreaterThan(0);
    });
  });

  describe("vectorStore failure", () => {
    it("sets error status when catalog query fails", async () => {
      const vectorStore = createMockVectorStore({
        keywordSearch: vi.fn().mockRejectedValue(new Error("Connection refused")),
      });

      await kubectlApply(vectorStore, { manifest: unknownCrdManifest });

      const span = getSpanByName("kubectl apply")!;
      expect(span.status.code).toBe(SpanStatusCode.ERROR);
      expect(span.attributes["error.type"]).toBe("CatalogValidationError");
    });
  });
});
