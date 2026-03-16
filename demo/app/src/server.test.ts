// ABOUTME: Tests for the demo app Hono server — validates DB connection behavior,
// ABOUTME: error messages, health probes, and route responses.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createApp } from "./server.js";
import type { Pool } from "pg";

/**
 * Creates a mock pg Pool for testing. By default, the pool connects successfully.
 * Override query to simulate connection failures.
 */
function createMockPool(
  overrides: Partial<{ query: ReturnType<typeof vi.fn> }> = {}
): Pool {
  return {
    query: vi.fn().mockResolvedValue({ rows: [{ now: new Date() }] }),
    ...overrides,
  } as unknown as Pool;
}

describe("GET /healthz", () => {
  it("returns 200 regardless of database state", async () => {
    const app = createApp({ pool: createMockPool() });
    const res = await app.request("/healthz");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("returns 200 even when pool is null (no DB configured)", async () => {
    const app = createApp({ pool: null });
    const res = await app.request("/healthz");
    expect(res.status).toBe(200);
  });
});

describe("GET /", () => {
  it("returns HTML page with spider image", async () => {
    const app = createApp({ pool: createMockPool() });
    const res = await app.request("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const body = await res.text();
    expect(body).toContain("Spider-v3.png");
  });

  it("includes YouTube links for Whitney and Viktor", async () => {
    const app = createApp({ pool: createMockPool() });
    const res = await app.request("/");
    const body = await res.text();
    expect(body).toContain("https://www.youtube.com/@wiggitywhitney");
    expect(body).toContain("https://www.youtube.com/@DevOpsToolkit");
  });

  it("has clickable top/bottom zones on the image", async () => {
    const app = createApp({ pool: createMockPool() });
    const res = await app.request("/");
    const body = await res.text();
    // Two link zones covering top and bottom halves
    expect(body).toContain('height: 50%');
  });
});

describe("startup behavior", () => {
  it("checkDatabaseConnection rejects when pool query fails", async () => {
    const { checkDatabaseConnection } = await import("./server.js");
    const failPool = createMockPool({
      query: vi.fn().mockRejectedValue(new Error("ECONNREFUSED")),
    });
    await expect(checkDatabaseConnection(failPool)).rejects.toThrow(
      "ECONNREFUSED"
    );
  });

  it("checkDatabaseConnection resolves when pool query succeeds", async () => {
    const { checkDatabaseConnection } = await import("./server.js");
    const pool = createMockPool();
    await expect(checkDatabaseConnection(pool)).resolves.toBeUndefined();
  });
});

describe("error message format", () => {
  it("produces agent-friendly error messages with [demo-app] prefix", async () => {
    const { formatStartupError } = await import("./server.js");
    const url = "db-service:5432/myapp";
    const error = new Error("Connection refused");
    const message = formatStartupError(url, error);
    expect(message).toContain("[demo-app]");
    expect(message).toContain("backend service");
    expect(message).toContain(url);
    expect(message).toContain("Connection refused");
  });

  it("error message does not reveal specific service type", async () => {
    const { formatStartupError } = await import("./server.js");
    const message = formatStartupError(
      "db-service:5432/myapp",
      new Error("fail")
    );
    expect(message).not.toContain("postgres");
    expect(message).not.toContain("database");
  });

  it("error message is single-line", async () => {
    const { formatStartupError } = await import("./server.js");
    const message = formatStartupError(
      "db-service:5432/app",
      new Error("fail")
    );
    expect(message).not.toContain("\n");
  });
});
