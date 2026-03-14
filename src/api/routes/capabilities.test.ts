// ABOUTME: Unit tests for the capability scan endpoint (PRD #42 M1).
// ABOUTME: Tests async 202 acceptance, background pipeline, validation, and concurrency limits.

/**
 * capabilities.test.ts - Unit tests for the capability scan endpoint (PRD #42 M1)
 *
 * Tests the POST /api/v1/capabilities/scan route using app.request() with
 * mock dependencies. No real server, ChromaDB, kubectl, or LLM needed.
 *
 * The route handler validates the payload synchronously, returns 202 immediately,
 * then runs the pipeline (discover → infer → store) in the background.
 * These tests verify the HTTP contract — validation, response codes, and
 * that the pipeline is invoked with the correct arguments.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import {
  createCapabilitiesRoute,
  MAX_SCAN_ITEMS,
  MAX_IN_FLIGHT_SCANS,
  resetInFlightScans,
  type CapabilitiesRouteDeps,
} from "./capabilities";
import { createMockVectorStore } from "../test-helpers";

// Reset module-level in-flight counter between tests so concurrency state
// from one test doesn't leak into the next.
beforeEach(() => {
  resetInFlightScans();
});

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Creates mock dependencies for the capabilities route.
 * All pipeline functions are stubs that resolve immediately.
 */
function createMockDeps(
  overrides?: Partial<CapabilitiesRouteDeps>
): CapabilitiesRouteDeps {
  return {
    vectorStore: createMockVectorStore(),
    discoverResources: vi.fn().mockResolvedValue([
      {
        name: "certificates.cert-manager.io",
        apiVersion: "cert-manager.io/v1",
        group: "cert-manager.io",
        kind: "Certificate",
        namespaced: true,
        isCRD: true,
        schema: "KIND: Certificate\nFIELDS: ...",
      },
    ]),
    inferCapabilities: vi.fn().mockResolvedValue([
      {
        resourceName: "certificates.cert-manager.io",
        apiVersion: "cert-manager.io/v1",
        group: "cert-manager.io",
        kind: "Certificate",
        capabilities: ["tls", "certificate-management"],
        providers: [],
        complexity: "medium" as const,
        description: "Manages TLS certificates",
        useCase: "Automate certificate lifecycle",
        confidence: 0.9,
      },
    ]),
    storeCapabilities: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

/** Helper to POST JSON to the scan endpoint */
function postScan(app: Hono, body: unknown) {
  return app.request("/api/v1/capabilities/scan", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Mounts the capabilities route on a Hono app at the expected path */
function createTestApp(deps: CapabilitiesRouteDeps): Hono {
  const app = new Hono();
  const route = createCapabilitiesRoute(deps);
  app.route("/api/v1/capabilities/scan", route);
  return app;
}

// ---------------------------------------------------------------------------
// POST /api/v1/capabilities/scan — accepted payloads (202)
// ---------------------------------------------------------------------------

describe("POST /api/v1/capabilities/scan — accepted", () => {
  it("returns 202 with accepted status for valid upserts", async () => {
    const deps = createMockDeps();
    const app = createTestApp(deps);

    const res = await postScan(app, {
      upserts: ["certificates.cert-manager.io"],
    });

    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body).toEqual({
      status: "accepted",
      upserts: 1,
      deletes: 0,
    });
  });

  it("returns 202 with accepted status for valid deletes", async () => {
    const deps = createMockDeps();
    const app = createTestApp(deps);

    const res = await postScan(app, {
      deletes: ["old-resource.example.io"],
    });

    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body).toEqual({
      status: "accepted",
      upserts: 0,
      deletes: 1,
    });
  });

  it("returns 202 for mixed upserts and deletes", async () => {
    const deps = createMockDeps();
    const app = createTestApp(deps);

    const res = await postScan(app, {
      upserts: ["certificates.cert-manager.io", "issuers.cert-manager.io"],
      deletes: ["old-resource.example.io"],
    });

    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body).toEqual({
      status: "accepted",
      upserts: 2,
      deletes: 1,
    });
  });

  it("returns 202 for empty payload (no-op)", async () => {
    const deps = createMockDeps();
    const app = createTestApp(deps);

    const res = await postScan(app, {});

    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body).toEqual({
      status: "accepted",
      upserts: 0,
      deletes: 0,
    });
  });
});

// ---------------------------------------------------------------------------
// POST /api/v1/capabilities/scan — pipeline invocation
// ---------------------------------------------------------------------------

describe("POST /api/v1/capabilities/scan — pipeline invocation", () => {
  it("calls discoverResources with scoped resourceNames for upserts", async () => {
    const deps = createMockDeps();
    const app = createTestApp(deps);

    await postScan(app, {
      upserts: ["certificates.cert-manager.io"],
    });

    // Wait for background processing
    await vi.waitFor(() => {
      expect(deps.discoverResources).toHaveBeenCalledWith(
        expect.objectContaining({
          resourceNames: ["certificates.cert-manager.io"],
        })
      );
    });
  });

  it("calls inferCapabilities with discovered resources", async () => {
    const deps = createMockDeps();
    const app = createTestApp(deps);

    await postScan(app, {
      upserts: ["certificates.cert-manager.io"],
    });

    await vi.waitFor(() => {
      expect(deps.inferCapabilities).toHaveBeenCalledWith(
        [
          expect.objectContaining({
            name: "certificates.cert-manager.io",
          }),
        ],
        expect.any(Object)
      );
    });
  });

  it("calls storeCapabilities with inferred results", async () => {
    const deps = createMockDeps();
    const app = createTestApp(deps);

    await postScan(app, {
      upserts: ["certificates.cert-manager.io"],
    });

    await vi.waitFor(() => {
      expect(deps.storeCapabilities).toHaveBeenCalledWith(
        [
          expect.objectContaining({
            resourceName: "certificates.cert-manager.io",
          }),
        ],
        deps.vectorStore,
        expect.any(Object)
      );
    });
  });

  it("processes deletes via vectorStore.delete", async () => {
    const deps = createMockDeps();
    const app = createTestApp(deps);

    await postScan(app, {
      deletes: ["old-resource.example.io"],
    });

    await vi.waitFor(() => {
      expect(deps.vectorStore.delete).toHaveBeenCalledWith("capabilities", [
        "old-resource.example.io",
      ]);
    });
  });

  it("does not call pipeline functions when upserts is empty", async () => {
    const deps = createMockDeps();
    const app = createTestApp(deps);

    await postScan(app, { deletes: ["old-resource.example.io"] });

    // Wait for background delete to complete, then verify pipeline was skipped
    await vi.waitFor(() => {
      expect(deps.vectorStore.delete).toHaveBeenCalled();
    });

    expect(deps.discoverResources).not.toHaveBeenCalled();
    expect(deps.inferCapabilities).not.toHaveBeenCalled();
    expect(deps.storeCapabilities).not.toHaveBeenCalled();
  });

  it("initializes collection before delete to avoid race condition", async () => {
    const deps = createMockDeps();
    const callOrder: string[] = [];

    // Gate initialize with a deferred promise to prove delete waits for it
    let releaseInitialize!: () => void;
    const initializeGate = new Promise<void>((resolve) => {
      releaseInitialize = resolve;
    });

    deps.vectorStore.initialize.mockImplementation(async () => {
      callOrder.push("initialize");
      await initializeGate;
    });
    (deps.vectorStore.delete as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      callOrder.push("delete");
    });
    const app = createTestApp(deps);

    await postScan(app, { deletes: ["old-resource.example.io"] });

    // initialize should be called but delete should NOT yet (still awaiting)
    await vi.waitFor(() => {
      expect(deps.vectorStore.initialize).toHaveBeenCalled();
    });
    expect(deps.vectorStore.delete).not.toHaveBeenCalled();

    // Release initialize — now delete should proceed
    releaseInitialize();
    await vi.waitFor(() => {
      expect(deps.vectorStore.delete).toHaveBeenCalled();
    });

    expect(callOrder[0]).toBe("initialize");
    expect(callOrder).toContain("delete");
    expect(deps.vectorStore.initialize).toHaveBeenCalledWith("capabilities", {
      distanceMetric: "cosine",
    });
  });

  it("does not call vectorStore.delete when deletes is empty", async () => {
    const deps = createMockDeps();
    const app = createTestApp(deps);

    await postScan(app, { upserts: ["certificates.cert-manager.io"] });

    // Wait for background pipeline to complete, then verify delete was skipped
    await vi.waitFor(() => {
      expect(deps.storeCapabilities).toHaveBeenCalled();
    });

    expect(deps.vectorStore.delete).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// POST /api/v1/capabilities/scan — validation errors (400)
// ---------------------------------------------------------------------------

describe("POST /api/v1/capabilities/scan — validation errors", () => {
  it("returns 400 for non-string values in upserts", async () => {
    const deps = createMockDeps();
    const app = createTestApp(deps);

    const res = await postScan(app, {
      upserts: [123],
    });

    expect(res.status).toBe(400);
  });

  it("returns 400 for non-object payload", async () => {
    const deps = createMockDeps();
    const app = createTestApp(deps);

    const res = await postScan(app, "not an object");

    expect(res.status).toBe(400);
  });

  it("returns 400 for malformed JSON body", async () => {
    const deps = createMockDeps();
    const app = createTestApp(deps);

    const res = await app.request("/api/v1/capabilities/scan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{broken json",
    });

    expect(res.status).toBe(400);
  });

  it("does not invoke pipeline on validation failure", async () => {
    const deps = createMockDeps();
    const app = createTestApp(deps);

    await postScan(app, { upserts: [123] });

    expect(deps.discoverResources).not.toHaveBeenCalled();
    expect(deps.vectorStore.delete).not.toHaveBeenCalled();
  });

  it("returns 400 when payload exceeds maximum item count", async () => {
    const deps = createMockDeps();
    const app = createTestApp(deps);

    const tooMany = Array.from(
      { length: MAX_SCAN_ITEMS + 1 },
      (_, i) => `resource-${i}.example.io`
    );
    const res = await postScan(app, { upserts: tooMany });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Payload too large");
  });
});

// ---------------------------------------------------------------------------
// POST /api/v1/capabilities/scan — concurrency limits (429)
// ---------------------------------------------------------------------------

describe("POST /api/v1/capabilities/scan — concurrency limits", () => {
  it("returns 429 when max in-flight scans are reached", async () => {
    // Create deps where discoverResources never resolves — simulates
    // long-running pipelines that hold in-flight slots.
    const deps = createMockDeps({
      discoverResources: vi.fn().mockReturnValue(new Promise(() => {})),
    });
    const app = createTestApp(deps);

    // Fill all in-flight slots with requests that never complete
    const pending: Promise<Response>[] = [];
    for (let i = 0; i < MAX_IN_FLIGHT_SCANS; i++) {
      pending.push(
        postScan(app, { upserts: [`resource-${i}.example.io`] })
      );
    }

    // All should be accepted (202)
    const responses = await Promise.all(pending);
    for (const res of responses) {
      expect(res.status).toBe(202);
    }

    // Allow setTimeout(0) callbacks to fire so in-flight counter increments
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Next request should be rejected (429)
    const res = await postScan(app, {
      upserts: ["one-too-many.example.io"],
    });

    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error).toBe("Too many scan jobs in progress");
  });
});
