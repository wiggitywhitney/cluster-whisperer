/**
 * instance-runner.ts - Instance sync pipeline runner (PRD #26 M3)
 *
 * Orchestrates the instance sync pipeline into a single operation:
 * 1. M1 (Discovery): Find all resource instances in the cluster
 * 2. Delete stale: Remove documents from the vector DB that no longer exist in the cluster
 * 3. M2 (Storage): Store instance metadata in the vector database
 *
 * This is the "glue" that makes the instance sync pipeline runnable. The CLI's
 * `sync-instances` subcommand creates the dependencies (VectorStore, etc.) and
 * calls syncInstances() with them.
 *
 * Unlike the capability runner (runner.ts), this pipeline has no LLM inference
 * step — it's discover → store with stale cleanup. The stale cleanup is needed
 * because resource instances come and go frequently (unlike resource types which
 * are relatively stable).
 */

import { discoverInstances } from "./instance-discovery";
import { storeInstances } from "./instance-storage";
import { INSTANCES_COLLECTION } from "../vectorstore";
import type { InstanceDiscoveryOptions } from "./types";
import type { VectorStore } from "../vectorstore";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Options for the instance sync pipeline runner.
 *
 * The vectorStore is required — the CLI creates it and passes it in.
 * All other options are forwarded to the individual pipeline stages.
 */
export interface SyncInstancesOptions {
  /** The vector store to write instances into */
  vectorStore: VectorStore;

  /** Options forwarded to M1 discoverInstances (e.g., injectable kubectl, resource type filter) */
  discoveryOptions?: InstanceDiscoveryOptions;

  /** Skip storage and delete — discover only, useful for testing */
  dryRun?: boolean;

  /**
   * Progress callback for the entire pipeline.
   * Passed to all stages so progress flows to a single output.
   * Defaults to stdout.
   */
  onProgress?: (message: string) => void;
}

/**
 * Summary of an instance sync run — what happened at each stage.
 */
export interface SyncInstancesResult {
  /** Number of instances discovered from the cluster */
  discovered: number;
  /** Number of instances stored in the vector DB (0 if dry run) */
  stored: number;
  /** Number of stale instances deleted from the vector DB */
  deleted: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Maximum number of existing documents to fetch when checking for stale entries.
 * This should be large enough to cover all instances in a typical cluster.
 */
const MAX_EXISTING_DOCS = 10_000;

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

/**
 * Runs the full instance sync pipeline: discover -> delete stale -> store.
 *
 * This is the main entry point for PRD #26 M3. It wires the pipeline stages
 * together, adding stale document cleanup between discovery and storage.
 *
 * Stale cleanup works by comparing what's in the vector DB against what was
 * just discovered in the cluster. Any document in the DB whose ID doesn't
 * appear in the discovered set is deleted. This handles the case where a
 * resource was deleted from the cluster since the last sync.
 *
 * @param options - VectorStore, stage options, dry-run flag, progress callback
 * @returns Summary counts for each stage
 * @throws Error if discovery fails (e.g., kubectl not available)
 */
export async function syncInstances(
  options: SyncInstancesOptions
): Promise<SyncInstancesResult> {
  const onProgress = options.onProgress ?? console.log; // eslint-disable-line no-console

  // M1: Discover instances from the cluster
  const discovered = await discoverInstances({
    ...options.discoveryOptions,
    onProgress,
  });

  let stored = 0;
  let deleted = 0;

  if (!options.dryRun) {
    // Initialize the collection before stale cleanup — on a first-ever sync,
    // the collection doesn't exist yet and deleteStaleDocuments needs to query it.
    // This is idempotent; storeInstances also calls initialize internally.
    await options.vectorStore.initialize(INSTANCES_COLLECTION, {
      distanceMetric: "cosine",
    });

    // Delete stale documents before storing new ones
    deleted = await deleteStaleDocuments(
      options.vectorStore,
      discovered.map((i) => i.id),
      onProgress
    );

    // M2: Store in vector database
    await storeInstances(discovered, options.vectorStore, { onProgress });
    stored = discovered.length;
  } else {
    onProgress("Dry run: skipping storage and stale cleanup.");
  }

  const result: SyncInstancesResult = {
    discovered: discovered.length,
    stored,
    deleted,
  };

  onProgress(
    `Sync complete: ${result.discovered} discovered, ${result.stored} stored, ${result.deleted} deleted.`
  );

  return result;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Finds and deletes documents in the vector DB that no longer exist in the cluster.
 *
 * Uses keywordSearch with no keyword to list all existing document IDs in the
 * instances collection, then compares against the set of currently discovered
 * instance IDs. Any ID present in the DB but missing from the cluster is stale
 * and gets deleted.
 *
 * @param vectorStore - The vector store to query and delete from
 * @param currentIds - IDs of instances that currently exist in the cluster
 * @param onProgress - Progress callback
 * @returns Number of stale documents deleted
 */
async function deleteStaleDocuments(
  vectorStore: VectorStore,
  currentIds: string[],
  onProgress: (message: string) => void
): Promise<number> {
  // Fetch all existing document IDs from the instances collection
  const existing = await vectorStore.keywordSearch(
    INSTANCES_COLLECTION,
    undefined,
    { nResults: MAX_EXISTING_DOCS }
  );

  if (existing.length === MAX_EXISTING_DOCS) {
    onProgress(
      `Warning: reached MAX_EXISTING_DOCS (${MAX_EXISTING_DOCS}); stale cleanup may be incomplete.`
    );
  }

  const currentIdSet = new Set(currentIds);
  const staleIds = existing
    .map((doc) => doc.id)
    .filter((id) => !currentIdSet.has(id));

  if (staleIds.length > 0) {
    onProgress(`Removing ${staleIds.length} stale instances from vector database...`);
    await vectorStore.delete(INSTANCES_COLLECTION, staleIds);
  }

  return staleIds.length;
}
