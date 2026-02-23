/**
 * instances.test.ts - Unit tests for the sync endpoint route (PRD #35 M2)
 *
 * Tests the POST /api/v1/instances/sync route using app.request() with a
 * mock VectorStore. No real server or ChromaDB needed.
 *
 * The route handler is a thin wrapper: validate (Zod), delegate (pipeline
 * functions), respond (status code). These tests verify the wiring between
 * those layers and the correct HTTP response for each scenario.
 */

import { describe, it, expect, vi } from "vitest";
import { createApp } from "../server";
import type { VectorStore } from "../../vectorstore";

// ---------------------------------------------------------------------------
// Test fixture helpers
// ---------------------------------------------------------------------------

/** Creates a mock VectorStore with all methods stubbed */
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

/** Creates a valid resource instance payload matching the controller's format */
function makeInstance(overrides: Record<string, unknown> = {}) {
  return {
    id: "default/apps/v1/Deployment/nginx",
    namespace: "default",
    name: "nginx",
    kind: "Deployment",
    apiVersion: "apps/v1",
    apiGroup: "apps",
    labels: { app: "nginx", tier: "frontend" },
    annotations: { description: "Main web server" },
    createdAt: "2026-02-20T10:00:00Z",
    ...overrides,
  };
}

/** Helper to POST JSON to the sync endpoint */
function postSync(app: ReturnType<typeof createApp>, body: unknown) {
  return app.request("/api/v1/instances/sync", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// POST /api/v1/instances/sync — successful upserts
// ---------------------------------------------------------------------------

describe("POST /api/v1/instances/sync — upserts", () => {
  it("returns 200 and upserts instances via the pipeline", async () => {
    const mockStore = createMockVectorStore();
    const app = createApp({ vectorStore: mockStore });

    const res = await postSync(app, {
      upserts: [makeInstance()],
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ status: "ok", upserted: 1, deleted: 0 });
  });

  it("calls storeInstances with the validated instances", async () => {
    const mockStore = createMockVectorStore();
    const app = createApp({ vectorStore: mockStore });

    await postSync(app, {
      upserts: [makeInstance()],
    });

    // storeInstances calls initialize then store
    expect(mockStore.initialize).toHaveBeenCalled();
    expect(mockStore.store).toHaveBeenCalledWith(
      "instances",
      expect.arrayContaining([
        expect.objectContaining({ id: "default/apps/v1/Deployment/nginx" }),
      ])
    );
  });

  it("handles multiple upserts", async () => {
    const mockStore = createMockVectorStore();
    const app = createApp({ vectorStore: mockStore });

    const res = await postSync(app, {
      upserts: [
        makeInstance(),
        makeInstance({
          id: "kube-system/v1/Service/kube-dns",
          namespace: "kube-system",
          name: "kube-dns",
          kind: "Service",
          apiVersion: "v1",
          apiGroup: "",
        }),
      ],
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ status: "ok", upserted: 2, deleted: 0 });
  });
});

// ---------------------------------------------------------------------------
// POST /api/v1/instances/sync — empty payloads
// ---------------------------------------------------------------------------

describe("POST /api/v1/instances/sync — empty payloads", () => {
  it("returns 200 with no processing for empty upserts array", async () => {
    const mockStore = createMockVectorStore();
    const app = createApp({ vectorStore: mockStore });

    const res = await postSync(app, { upserts: [] });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ status: "ok", upserted: 0, deleted: 0 });
    // storeInstances is still called but handles empty array internally
  });

  it("returns 200 for empty object payload", async () => {
    const mockStore = createMockVectorStore();
    const app = createApp({ vectorStore: mockStore });

    const res = await postSync(app, {});

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ status: "ok", upserted: 0, deleted: 0 });
  });
});

// ---------------------------------------------------------------------------
// POST /api/v1/instances/sync — validation errors (400)
// ---------------------------------------------------------------------------

describe("POST /api/v1/instances/sync — validation errors", () => {
  it("returns 400 for invalid instance shape in upserts", async () => {
    const mockStore = createMockVectorStore();
    const app = createApp({ vectorStore: mockStore });

    const res = await postSync(app, {
      upserts: [{ notValid: true }],
    });

    expect(res.status).toBe(400);
  });

  it("returns 400 for non-object payload", async () => {
    const mockStore = createMockVectorStore();
    const app = createApp({ vectorStore: mockStore });

    const res = await postSync(app, "not an object");

    expect(res.status).toBe(400);
  });

  it("does not call vector store on validation failure", async () => {
    const mockStore = createMockVectorStore();
    const app = createApp({ vectorStore: mockStore });

    await postSync(app, { upserts: [{ notValid: true }] });

    expect(mockStore.store).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// POST /api/v1/instances/sync — vector DB errors (500)
// ---------------------------------------------------------------------------

describe("POST /api/v1/instances/sync — DB errors", () => {
  it("returns 500 when vector store fails during upserts", async () => {
    const mockStore = createMockVectorStore();
    mockStore.store.mockRejectedValue(new Error("ChromaDB connection refused"));
    const app = createApp({ vectorStore: mockStore });

    const res = await postSync(app, {
      upserts: [makeInstance()],
    });

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toContain("ChromaDB connection refused");
  });

  it("returns 500 when vector store initialize fails", async () => {
    const mockStore = createMockVectorStore();
    mockStore.initialize.mockRejectedValue(new Error("DB timeout"));
    const app = createApp({ vectorStore: mockStore });

    const res = await postSync(app, {
      upserts: [makeInstance()],
    });

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toContain("DB timeout");
  });
});

// ---------------------------------------------------------------------------
// POST /api/v1/instances/sync — deletes accepted but not processed (M2)
// ---------------------------------------------------------------------------

describe("POST /api/v1/instances/sync — deletes field (M2 passthrough)", () => {
  it("accepts deletes in the payload without processing them", async () => {
    const mockStore = createMockVectorStore();
    const app = createApp({ vectorStore: mockStore });

    const res = await postSync(app, {
      upserts: [makeInstance()],
      deletes: ["default/apps/v1/Deployment/old-service"],
    });

    expect(res.status).toBe(200);
    // Deletes accepted by schema but not processed until M3
    expect(mockStore.delete).not.toHaveBeenCalled();
  });
});
