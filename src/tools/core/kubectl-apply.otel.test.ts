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

// Platform CRD — used for successful apply and execution failure tests.
const managedServiceManifest = [
  "apiVersion: platform.acme.io/v1alpha1",
  "kind: ManagedService",
  "metadata:",
  "  name: youchoose-db",
].join("\n");

// Import after mocks
const { kubectlApply } = await import("./kubectl-apply");

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("kubectl-apply OTel spans", () => {
  describe("successful apply", () => {
    it("creates a span named 'kubectl apply'", async () => {
      mockSpawnSync.mockReturnValue({
        stdout: "created", stderr: "", status: 0, error: null,
      });

      await kubectlApply({ manifest: managedServiceManifest });

      const span = getSpanByName("kubectl apply");
      expect(span).toBeDefined();
    });

    it("sets span kind to CLIENT", async () => {
      mockSpawnSync.mockReturnValue({
        stdout: "created", stderr: "", status: 0, error: null,
      });

      await kubectlApply({ manifest: managedServiceManifest });

      const span = getSpanByName("kubectl apply")!;
      expect(span.kind).toBe(SpanKind.CLIENT);
    });

    it("sets resource kind and api group attributes", async () => {
      mockSpawnSync.mockReturnValue({
        stdout: "created", stderr: "", status: 0, error: null,
      });

      await kubectlApply({ manifest: managedServiceManifest });

      const span = getSpanByName("kubectl apply")!;
      expect(span.attributes["cluster_whisperer.k8s.resource_kind"]).toBe("ManagedService");
      expect(span.attributes["cluster_whisperer.k8s.api_group"]).toBe("platform.acme.io");
    });

    it("sets process attributes on success", async () => {
      mockSpawnSync.mockReturnValue({
        stdout: "managedservice.platform.acme.io/youchoose-db created", stderr: "", status: 0, error: null,
      });

      await kubectlApply({ manifest: managedServiceManifest });

      const span = getSpanByName("kubectl apply")!;
      expect(span.attributes["process.executable.name"]).toBe("kubectl");
      expect(span.attributes["process.exit.code"]).toBe(0);
      expect(span.status.code).toBe(SpanStatusCode.OK);
    });

    it("sets output size attribute", async () => {
      const output = "managedservice.platform.acme.io/youchoose-db created\n";
      mockSpawnSync.mockReturnValue({
        stdout: output, stderr: "", status: 0, error: null,
      });

      await kubectlApply({ manifest: managedServiceManifest });

      const span = getSpanByName("kubectl apply")!;
      expect(span.attributes["cluster_whisperer.k8s.output_size_bytes"]).toBe(
        Buffer.byteLength(output, "utf-8")
      );
    });
  });

  describe("YAML parse error", () => {
    it("sets error status for invalid YAML", async () => {
      await kubectlApply({ manifest: "not: valid: {{{" });

      const span = getSpanByName("kubectl apply")!;
      expect(span.status.code).toBe(SpanStatusCode.ERROR);
      expect(span.attributes["error.type"]).toBe("YAMLParseError");
    });
  });

  describe("kubectl execution failure", () => {
    it("sets error status when kubectl returns non-zero exit", async () => {
      mockSpawnSync.mockReturnValue({
        stdout: "", stderr: "error: connection refused", status: 1, error: null,
      });

      await kubectlApply({ manifest: managedServiceManifest });

      const span = getSpanByName("kubectl apply")!;
      expect(span.status.code).toBe(SpanStatusCode.ERROR);
      expect(span.attributes["process.exit.code"]).toBe(1);
    });

    it("sets error status when kubectl returns Kyverno admission rejection", async () => {
      const kyvernoError = `Error from server: admission webhook "validate.kyverno.svc" denied the request: [require-approved-resources] Only ManagedService resources from platform.acme.io are allowed.`;
      mockSpawnSync.mockReturnValue({
        stdout: "", stderr: kyvernoError, status: 1, error: null,
      });

      await kubectlApply({ manifest: managedServiceManifest });

      const span = getSpanByName("kubectl apply")!;
      expect(span.status.code).toBe(SpanStatusCode.ERROR);
      expect(span.attributes["error.type"]).toBe("KubectlError");
    });

    it("records exception when kubectl spawn fails", async () => {
      mockSpawnSync.mockReturnValue({
        stdout: "", stderr: "", status: null, error: new Error("ENOENT"),
      });

      await kubectlApply({ manifest: managedServiceManifest });

      const span = getSpanByName("kubectl apply")!;
      expect(span.status.code).toBe(SpanStatusCode.ERROR);
      expect(span.events.some((event) => event.name === "exception")).toBe(true);
    });
  });
});
