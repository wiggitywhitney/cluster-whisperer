// ABOUTME: Unit tests for the instance sync endpoint route (PRD #35 M2-M3).
// ABOUTME: Tests upserts, deletes, validation, ordering, and error handling via app.request().

/**
 * instances.test.ts - Unit tests for the sync endpoint route (PRD #35 M2–M3)
 *
 * Tests the POST /api/v1/instances/sync route using app.request() with a
 * mock VectorStore. No real server or ChromaDB needed.
 *
 * The route handler is a thin wrapper: validate (Zod), delegate (pipeline
 * functions), respond (status code). These tests verify the wiring between
 * those layers and the correct HTTP response for each scenario.
 *
 * M2 tests cover upserts, validation, and error handling.
 * M3 tests cover deletes, mixed payloads, delete ordering, and delete errors.
 * M4 tests cover error handling edge cases: malformed JSON and large payloads.
 */

import { describe, it, expect } from "vitest";
import { createApp } from "../server";
import { createMockVectorStore, makeInstance } from "../test-helpers";

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
// POST /api/v1/instances/sync — deletes (M3)
// ---------------------------------------------------------------------------

describe("POST /api/v1/instances/sync — deletes", () => {
  it("deletes instances by ID from the vector store", async () => {
    const mockStore = createMockVectorStore();
    const app = createApp({ vectorStore: mockStore });

    const res = await postSync(app, {
      deletes: ["default/apps/v1/Deployment/old-service"],
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ status: "ok", upserted: 0, deleted: 1 });
    expect(mockStore.delete).toHaveBeenCalledWith("instances", [
      "default/apps/v1/Deployment/old-service",
    ]);
  });

  it("handles multiple deletes", async () => {
    const mockStore = createMockVectorStore();
    const app = createApp({ vectorStore: mockStore });

    const res = await postSync(app, {
      deletes: [
        "default/apps/v1/Deployment/old-service",
        "kube-system/v1/Service/legacy-dns",
      ],
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ status: "ok", upserted: 0, deleted: 2 });
    expect(mockStore.delete).toHaveBeenCalledWith("instances", [
      "default/apps/v1/Deployment/old-service",
      "kube-system/v1/Service/legacy-dns",
    ]);
  });

  it("skips vectorStore.delete when deletes array is empty", async () => {
    const mockStore = createMockVectorStore();
    const app = createApp({ vectorStore: mockStore });

    const res = await postSync(app, {
      upserts: [makeInstance()],
      deletes: [],
    });

    expect(res.status).toBe(200);
    expect(mockStore.delete).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// POST /api/v1/instances/sync — mixed payloads (M3)
// ---------------------------------------------------------------------------

describe("POST /api/v1/instances/sync — mixed upserts + deletes", () => {
  it("processes both upserts and deletes in the same request", async () => {
    const mockStore = createMockVectorStore();
    const app = createApp({ vectorStore: mockStore });

    const res = await postSync(app, {
      upserts: [makeInstance()],
      deletes: ["default/apps/v1/Deployment/old-service"],
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ status: "ok", upserted: 1, deleted: 1 });
    expect(mockStore.delete).toHaveBeenCalled();
    expect(mockStore.store).toHaveBeenCalled();
  });

  it("processes deletes before upserts", async () => {
    const mockStore = createMockVectorStore();
    const callOrder: string[] = [];
    mockStore.initialize.mockImplementation(async () => {
      callOrder.push("initialize");
    });
    mockStore.delete.mockImplementation(async () => {
      callOrder.push("delete");
    });
    mockStore.store.mockImplementation(async () => {
      callOrder.push("store");
    });
    const app = createApp({ vectorStore: mockStore });

    await postSync(app, {
      upserts: [makeInstance()],
      deletes: ["default/apps/v1/Deployment/old-service"],
    });

    // initialize is called first (route handler), then delete, then
    // storeInstances calls initialize again (idempotent) before store
    expect(callOrder[0]).toBe("initialize");
    expect(callOrder.indexOf("delete")).toBeGreaterThan(0);
    expect(callOrder.indexOf("store")).toBeGreaterThan(callOrder.indexOf("delete"));
  });

  it("initializes collection before delete to avoid race condition", async () => {
    const mockStore = createMockVectorStore();
    const callOrder: string[] = [];
    mockStore.initialize.mockImplementation(async () => {
      callOrder.push("initialize");
    });
    mockStore.delete.mockImplementation(async () => {
      callOrder.push("delete");
    });
    const app = createApp({ vectorStore: mockStore });

    await postSync(app, {
      deletes: ["default/apps/v1/Deployment/old-service"],
    });

    expect(callOrder[0]).toBe("initialize");
    expect(callOrder).toContain("delete");
  });
});

// ---------------------------------------------------------------------------
// POST /api/v1/instances/sync — delete DB errors (M3)
// ---------------------------------------------------------------------------

describe("POST /api/v1/instances/sync — delete DB errors", () => {
  it("returns 500 when vector store fails during deletes", async () => {
    const mockStore = createMockVectorStore();
    mockStore.delete.mockRejectedValue(
      new Error("ChromaDB connection refused")
    );
    const app = createApp({ vectorStore: mockStore });

    const res = await postSync(app, {
      deletes: ["default/apps/v1/Deployment/old-service"],
    });

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toContain("ChromaDB connection refused");
  });

  it("does not process upserts if deletes fail", async () => {
    const mockStore = createMockVectorStore();
    mockStore.delete.mockRejectedValue(new Error("DB error"));
    const app = createApp({ vectorStore: mockStore });

    await postSync(app, {
      upserts: [makeInstance()],
      deletes: ["default/apps/v1/Deployment/old-service"],
    });

    // Deletes run first and fail — upserts should not execute
    expect(mockStore.store).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// POST /api/v1/instances/sync — error handling edge cases (M4)
// ---------------------------------------------------------------------------

describe("POST /api/v1/instances/sync — error handling edge cases", () => {
  it("returns 400 for malformed JSON body", async () => {
    const mockStore = createMockVectorStore();
    const app = createApp({ vectorStore: mockStore });

    // Send raw malformed JSON — can't use postSync() since it JSON.stringify()s
    const res = await app.request("/api/v1/instances/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{broken json",
    });

    expect(res.status).toBe(400);
    expect(mockStore.store).not.toHaveBeenCalled();
    expect(mockStore.delete).not.toHaveBeenCalled();
  });

  it("handles large payloads with many instances", async () => {
    const mockStore = createMockVectorStore();
    const app = createApp({ vectorStore: mockStore });

    // Generate 100 unique instances — controller batches, but test the boundary
    const instances = Array.from({ length: 100 }, (_, i) =>
      makeInstance({
        id: `namespace-${i}/apps/v1/Deployment/service-${i}`,
        name: `service-${i}`,
        namespace: `namespace-${i}`,
      })
    );

    const res = await postSync(app, {
      upserts: instances,
      deletes: Array.from({ length: 50 }, (_, i) => `old/apps/v1/Deployment/legacy-${i}`),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ status: "ok", upserted: 100, deleted: 50 });
    expect(mockStore.delete).toHaveBeenCalledWith(
      "instances",
      expect.arrayContaining(["old/apps/v1/Deployment/legacy-0"])
    );
    expect(mockStore.store).toHaveBeenCalled();
  });
});
