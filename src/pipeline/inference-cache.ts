// ABOUTME: File-based cache for LLM inference results to avoid re-running expensive Haiku calls
// ABOUTME: Cache key = hash of resource name + schema; invalidates automatically on schema changes

/**
 * inference-cache.ts - Persistent cache for capability inference results
 *
 * What this file does:
 * Caches LLM inference results to disk so re-runs of the sync pipeline skip
 * resources that have already been processed. Each resource's cache key is a
 * hash of its name and schema — if the schema changes (e.g., CRD upgrade),
 * the cache automatically misses and the resource is re-inferred.
 *
 * Why this exists:
 * The sync pipeline processes hundreds of CRDs sequentially through Claude Haiku,
 * taking ~30 minutes and ~$3 in API costs. If storage fails after inference
 * completes, the entire inference must be re-run without caching.
 *
 * Cache format:
 * A single JSON file at `<cacheDir>/cache.json` containing a version number
 * and a map of cache keys to inference results.
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import type { ResourceCapability, DiscoveredResource } from "./types";

/** Current cache file format version. Bump to invalidate all existing caches. */
const CACHE_VERSION = 1;

/** Name of the cache file within the cache directory. */
const CACHE_FILENAME = "cache.json";

/**
 * A single cached inference result.
 */
export interface CacheEntry {
  /** The resource name this result belongs to */
  resourceName: string;
  /** The cache key (hash of name + schema) that produced this result */
  cacheKey: string;
  /** The LLM inference result */
  result: ResourceCapability;
  /** ISO timestamp of when this entry was cached */
  cachedAt: string;
}

/**
 * The on-disk cache file structure.
 */
export interface InferenceCacheFile {
  version: number;
  entries: Record<string, CacheEntry>;
}

/**
 * Computes a deterministic cache key for a discovered resource.
 *
 * The key is a SHA-256 hash of the resource name concatenated with its schema.
 * This means:
 * - Same resource + same schema → same key (cache hit)
 * - Same resource + different schema → different key (cache miss, re-infer)
 * - Different resource → different key
 */
export function computeCacheKey(resource: DiscoveredResource): string {
  return createHash("sha256")
    .update(resource.name)
    .update(resource.schema)
    .digest("hex")
    .substring(0, 16);
}

/**
 * Loads the cache from disk, returning an empty cache if the file doesn't
 * exist or has an incompatible version.
 */
export function loadCache(cacheDir: string): InferenceCacheFile {
  try {
    const data = readFileSync(join(cacheDir, CACHE_FILENAME), "utf-8");
    const parsed = JSON.parse(data) as InferenceCacheFile;
    if (parsed.version !== CACHE_VERSION) {
      return { version: CACHE_VERSION, entries: {} };
    }
    return parsed;
  } catch {
    return { version: CACHE_VERSION, entries: {} };
  }
}

/**
 * Saves the cache to disk atomically (write to temp file, then rename).
 * Creates the cache directory if it doesn't exist.
 */
export function saveCache(
  cacheDir: string,
  cache: InferenceCacheFile
): void {
  mkdirSync(cacheDir, { recursive: true });
  const filePath = join(cacheDir, CACHE_FILENAME);
  const tempPath = filePath + ".tmp";
  writeFileSync(tempPath, JSON.stringify(cache, null, 2));
  renameSync(tempPath, filePath);
}

/**
 * Looks up a cached inference result by cache key.
 * Returns undefined on cache miss.
 */
export function getCachedResult(
  cache: InferenceCacheFile,
  key: string
): ResourceCapability | undefined {
  return cache.entries[key]?.result;
}

/**
 * Adds an inference result to the in-memory cache.
 * Call saveCache() afterward to persist to disk.
 */
export function setCachedResult(
  cache: InferenceCacheFile,
  key: string,
  entry: CacheEntry
): void {
  cache.entries[key] = entry;
}
