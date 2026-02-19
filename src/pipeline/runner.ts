/**
 * runner.ts - Sync pipeline runner (M4)
 *
 * Orchestrates the three pipeline stages into a single sync operation:
 * 1. M1 (Discovery): Find all resource types in the cluster
 * 2. M2 (Inference): Ask an LLM to describe each resource's capabilities
 * 3. M3 (Storage): Store the descriptions in the vector database
 *
 * This is the "glue" that makes the pipeline runnable. The CLI's `sync`
 * subcommand creates the dependencies (VectorStore, etc.) and calls
 * syncCapabilities() with them.
 *
 * The runner accepts the same DI options as the individual stages, forwarding
 * them through so the full pipeline is testable with mocked boundaries.
 */

import { discoverResources } from "./discovery";
import { inferCapabilities } from "./inference";
import { storeCapabilities } from "./storage";
import type {
  DiscoveryOptions,
  InferenceOptions,
} from "./types";
import type { VectorStore } from "../vectorstore";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Options for the sync pipeline runner.
 *
 * The vectorStore is required — the CLI creates it and passes it in.
 * All other options are forwarded to the individual pipeline stages.
 */
export interface SyncOptions {
  /** The vector store to write capabilities into */
  vectorStore: VectorStore;

  /** Options forwarded to M1 discoverResources (e.g., injectable kubectl) */
  discoveryOptions?: DiscoveryOptions;

  /** Options forwarded to M2 inferCapabilities (e.g., injectable model) */
  inferenceOptions?: InferenceOptions;

  /** Skip storage — discover and infer only, useful for testing */
  dryRun?: boolean;

  /**
   * Progress callback for the entire pipeline.
   * Passed to all three stages so progress flows to a single output.
   * Defaults to stdout.
   */
  onProgress?: (message: string) => void;
}

/**
 * Summary of a sync run — what happened at each stage.
 */
export interface SyncResult {
  /** Number of resources discovered from the cluster */
  discovered: number;
  /** Number of capabilities successfully inferred by the LLM */
  inferred: number;
  /** Number of capabilities stored in the vector DB (0 if dry run) */
  stored: number;
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

/**
 * Runs the full capability sync pipeline: discover -> infer -> store.
 *
 * This is the main entry point for M4. It wires the three pipeline stages
 * together, forwarding DI options and progress callbacks to each stage.
 *
 * @param options - VectorStore, stage options, dry-run flag, progress callback
 * @returns Summary counts for each stage
 * @throws Error if discovery fails (e.g., kubectl not available)
 */
export async function syncCapabilities(
  options: SyncOptions
): Promise<SyncResult> {
  const onProgress = options.onProgress ?? console.log; // eslint-disable-line no-console

  // M1: Discover resources from the cluster
  const discovered = await discoverResources({
    ...options.discoveryOptions,
    onProgress,
  });

  // M2: Infer capabilities via LLM
  const capabilities = await inferCapabilities(discovered, {
    ...options.inferenceOptions,
    onProgress,
  });

  // M3: Store in vector database (unless dry run)
  let stored = 0;
  if (!options.dryRun) {
    await storeCapabilities(capabilities, options.vectorStore, { onProgress });
    stored = capabilities.length;
  } else {
    onProgress("Dry run: skipping storage.");
  }

  const result: SyncResult = {
    discovered: discovered.length,
    inferred: capabilities.length,
    stored,
  };

  onProgress(
    `Sync complete: ${result.discovered} discovered, ${result.inferred} inferred, ${result.stored} stored.`
  );

  return result;
}
