/**
 * server.test.ts - Unit tests for the HTTP server and health probes (PRD #35 M1)
 *
 * Tests the Hono app factory and probe routes using app.request() —
 * no real server is started, no ports are needed.
 *
 * The createApp() factory accepts a VectorStore dependency for the
 * readiness probe, making it injectable for testing with a mock.
 */

import { describe, it, expect } from "vitest";
import { createApp } from "./server";
import { createMockVectorStore } from "./test-helpers";

// ---------------------------------------------------------------------------
// GET /healthz — liveness probe
// ---------------------------------------------------------------------------

describe("GET /healthz", () => {
  it("returns 200 with status ok", async () => {
    const mockStore = createMockVectorStore();
    const app = createApp({ vectorStore: mockStore });

    const res = await app.request("/healthz");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("returns 200 even when vector store is unreachable", async () => {
    const mockStore = createMockVectorStore();
    mockStore.initialize.mockRejectedValue(new Error("connection refused"));
    const app = createApp({ vectorStore: mockStore });

    const res = await app.request("/healthz");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });
});

// ---------------------------------------------------------------------------
// GET /readyz — readiness probe
// ---------------------------------------------------------------------------

describe("GET /readyz", () => {
  it("returns 200 when ChromaDB is reachable", async () => {
    const mockStore = createMockVectorStore();
    const app = createApp({ vectorStore: mockStore });

    const res = await app.request("/readyz");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("returns 503 when ChromaDB is unreachable", async () => {
    const mockStore = createMockVectorStore();
    mockStore.initialize.mockRejectedValue(
      new Error("ECONNREFUSED 127.0.0.1:8000")
    );
    const app = createApp({ vectorStore: mockStore });

    const res = await app.request("/readyz");

    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.status).toBe("unavailable");
    expect(body.error).toContain("ECONNREFUSED");
  });

  it("checks connectivity using vector store initialize", async () => {
    const mockStore = createMockVectorStore();
    const app = createApp({ vectorStore: mockStore });

    await app.request("/readyz");

    expect(mockStore.initialize).toHaveBeenCalledWith("instances", {
      distanceMetric: "cosine",
    });
  });
});

// ---------------------------------------------------------------------------
// Unknown routes
// ---------------------------------------------------------------------------

describe("unknown routes", () => {
  it("returns 404 for unregistered paths", async () => {
    const mockStore = createMockVectorStore();
    const app = createApp({ vectorStore: mockStore });

    const res = await app.request("/nonexistent");

    expect(res.status).toBe(404);
  });
});
