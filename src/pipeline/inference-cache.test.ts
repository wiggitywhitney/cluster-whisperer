// ABOUTME: Unit tests for inference cache — key computation, persistence, lookup, and round-trip
// ABOUTME: Uses temp directories for isolation so tests don't interfere with each other
/**
 * inference-cache.test.ts - Unit tests for the inference cache module
 *
 * Tests cache key computation, file persistence (load/save), and
 * lookup/storage of cached inference results. Uses temp directories
 * for isolation so tests don't interfere with each other.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  computeCacheKey,
  loadCache,
  saveCache,
  getCachedResult,
  setCachedResult,
} from "./inference-cache";
import type { CacheEntry, InferenceCacheFile } from "./inference-cache";
import type { DiscoveredResource, ResourceCapability } from "./types";

// ---------------------------------------------------------------------------
// Test fixture helpers
// ---------------------------------------------------------------------------

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
    complexity: "medium",
    description: "Managed SQL database",
    useCase: "Deploy a managed database",
    confidence: 0.9,
    ...overrides,
  };
}

function makeCacheEntry(overrides: Partial<CacheEntry> = {}): CacheEntry {
  return {
    resourceName: "sqls.devopstoolkit.live",
    cacheKey: "abc123",
    result: makeCapability(),
    cachedAt: "2026-03-13T00:00:00.000Z",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("computeCacheKey", () => {
  it("returns a 16-character hex string", () => {
    const key = computeCacheKey(makeResource());
    expect(key).toMatch(/^[0-9a-f]{16}$/);
  });

  it("is deterministic — same input produces same key", () => {
    const resource = makeResource();
    const key1 = computeCacheKey(resource);
    const key2 = computeCacheKey(resource);
    expect(key1).toBe(key2);
  });

  it("produces different keys for different resource names", () => {
    const key1 = computeCacheKey(makeResource({ name: "deployments.apps" }));
    const key2 = computeCacheKey(makeResource({ name: "services" }));
    expect(key1).not.toBe(key2);
  });

  it("produces different keys when schema changes (automatic invalidation)", () => {
    const key1 = computeCacheKey(makeResource({ schema: "schema v1" }));
    const key2 = computeCacheKey(makeResource({ schema: "schema v2" }));
    expect(key1).not.toBe(key2);
  });

  it("produces same key regardless of other field changes", () => {
    const key1 = computeCacheKey(makeResource({ kind: "SQL" }));
    const key2 = computeCacheKey(makeResource({ kind: "Database" }));
    // Cache key only depends on name + schema, not other fields
    expect(key1).toBe(key2);
  });
});

describe("loadCache", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "inference-cache-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns empty cache when directory does not contain cache file", () => {
    const cache = loadCache(tempDir);
    expect(cache.version).toBe(1);
    expect(cache.entries).toEqual({});
  });

  it("returns empty cache when directory does not exist", () => {
    const cache = loadCache(join(tempDir, "nonexistent"));
    expect(cache.version).toBe(1);
    expect(cache.entries).toEqual({});
  });

  it("loads a valid cache file", () => {
    const cacheData: InferenceCacheFile = {
      version: 1,
      entries: {
        abc123: makeCacheEntry({ cacheKey: "abc123" }),
      },
    };
    const { writeFileSync } = require("node:fs");
    writeFileSync(join(tempDir, "cache.json"), JSON.stringify(cacheData));

    const loaded = loadCache(tempDir);
    expect(loaded.version).toBe(1);
    expect(Object.keys(loaded.entries)).toHaveLength(1);
    expect(loaded.entries["abc123"].resourceName).toBe(
      "sqls.devopstoolkit.live"
    );
  });

  it("returns empty cache when version doesn't match", () => {
    const cacheData = {
      version: 999,
      entries: { abc123: makeCacheEntry() },
    };
    const { writeFileSync } = require("node:fs");
    writeFileSync(join(tempDir, "cache.json"), JSON.stringify(cacheData));

    const loaded = loadCache(tempDir);
    expect(loaded.version).toBe(1);
    expect(loaded.entries).toEqual({});
  });

  it("returns empty cache when file contains invalid JSON", () => {
    const { writeFileSync } = require("node:fs");
    writeFileSync(join(tempDir, "cache.json"), "not valid json{{{");

    const loaded = loadCache(tempDir);
    expect(loaded.version).toBe(1);
    expect(loaded.entries).toEqual({});
  });
});

describe("saveCache", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "inference-cache-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("writes cache to disk and can be loaded back", () => {
    const cache: InferenceCacheFile = {
      version: 1,
      entries: {
        key1: makeCacheEntry({ cacheKey: "key1" }),
      },
    };

    saveCache(tempDir, cache);

    const loaded = loadCache(tempDir);
    expect(loaded.version).toBe(1);
    expect(loaded.entries["key1"].resourceName).toBe(
      "sqls.devopstoolkit.live"
    );
  });

  it("creates the cache directory if it doesn't exist", () => {
    const nestedDir = join(tempDir, "deep", "nested", "dir");
    const cache: InferenceCacheFile = { version: 1, entries: {} };

    saveCache(nestedDir, cache);

    const loaded = loadCache(nestedDir);
    expect(loaded.version).toBe(1);
  });

  it("writes valid JSON", () => {
    const cache: InferenceCacheFile = {
      version: 1,
      entries: {
        key1: makeCacheEntry({ cacheKey: "key1" }),
      },
    };

    saveCache(tempDir, cache);

    const raw = readFileSync(join(tempDir, "cache.json"), "utf-8");
    const parsed = JSON.parse(raw);
    expect(parsed.version).toBe(1);
    expect(parsed.entries.key1).toBeDefined();
  });
});

describe("getCachedResult", () => {
  it("returns the result for a known key", () => {
    const capability = makeCapability();
    const cache: InferenceCacheFile = {
      version: 1,
      entries: {
        myKey: makeCacheEntry({ cacheKey: "myKey", result: capability }),
      },
    };

    const result = getCachedResult(cache, "myKey");
    expect(result).toEqual(capability);
  });

  it("returns undefined for an unknown key", () => {
    const cache: InferenceCacheFile = { version: 1, entries: {} };
    const result = getCachedResult(cache, "missing");
    expect(result).toBeUndefined();
  });
});

describe("setCachedResult", () => {
  it("adds a new entry to the cache", () => {
    const cache: InferenceCacheFile = { version: 1, entries: {} };
    const entry = makeCacheEntry({ cacheKey: "newKey" });

    setCachedResult(cache, "newKey", entry);

    expect(cache.entries["newKey"]).toBe(entry);
    expect(getCachedResult(cache, "newKey")).toEqual(entry.result);
  });

  it("overwrites an existing entry", () => {
    const cache: InferenceCacheFile = {
      version: 1,
      entries: {
        key: makeCacheEntry({ cacheKey: "key" }),
      },
    };
    const newCapability = makeCapability({ description: "Updated" });
    const newEntry = makeCacheEntry({
      cacheKey: "key",
      result: newCapability,
    });

    setCachedResult(cache, "key", newEntry);

    expect(getCachedResult(cache, "key")?.description).toBe("Updated");
  });
});

describe("full round-trip", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "inference-cache-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("compute key → set → save → load → get returns original result", () => {
    const resource = makeResource();
    const key = computeCacheKey(resource);
    const capability = makeCapability();

    // Build and persist cache
    const cache = loadCache(tempDir);
    setCachedResult(cache, key, {
      resourceName: resource.name,
      cacheKey: key,
      result: capability,
      cachedAt: new Date().toISOString(),
    });
    saveCache(tempDir, cache);

    // Load from disk and verify
    const reloaded = loadCache(tempDir);
    const result = getCachedResult(reloaded, key);
    expect(result).toEqual(capability);
  });
});
