/**
 * test-helpers.ts - Shared test fixtures for API tests (PRD #35)
 *
 * Provides reusable mock factories and fixture builders used across
 * server.test.ts, instances.test.ts, and sync-payload.test.ts.
 */

import { vi } from "vitest";
import type { VectorStore } from "../vectorstore";

/** Creates a mock VectorStore with all methods stubbed */
export function createMockVectorStore(): VectorStore & {
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
export function makeInstance(overrides: Record<string, unknown> = {}) {
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
