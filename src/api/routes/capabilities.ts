/**
 * capabilities.ts - Capability scan endpoint route handler (PRD #42 M1)
 *
 * Receives CRD names from the k8s-vectordb-sync controller and triggers
 * capability inference for those resources. Unlike the instance sync
 * endpoint (which processes synchronously), this endpoint accepts the
 * payload immediately (202) and processes in the background because
 * capability inference involves LLM calls (~5s per resource).
 *
 * Processing flow:
 * 1. Validate payload (synchronous — 400 on bad input)
 * 2. Return 202 Accepted with counts from the payload
 * 3. Background: process deletes via vectorStore.delete()
 * 4. Background: run discover → infer → store pipeline for upserts
 *
 * The controller's job is done once it receives 202. Pipeline failures
 * are observable via OTel spans (PRD #37), not via HTTP response.
 */

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { ScanPayloadSchema } from "../schemas/scan-payload";
import { CAPABILITIES_COLLECTION } from "../../vectorstore";
import type { VectorStore } from "../../vectorstore";
import type {
  DiscoveredResource,
  ResourceCapability,
  DiscoveryOptions,
  InferenceOptions,
  StorageOptions,
} from "../../pipeline/types";

/**
 * Dependencies for the capabilities route.
 *
 * Each pipeline function is injected so tests can stub them independently.
 * Production wires the real implementations from pipeline/*.ts.
 */
export interface CapabilitiesRouteDeps {
  /** Vector store for deletes and for storeCapabilities */
  vectorStore: VectorStore;
  /** Discovery function — scoped via resourceNames option */
  discoverResources: (
    options?: DiscoveryOptions
  ) => Promise<DiscoveredResource[]>;
  /** Inference function — calls LLM for each discovered resource */
  inferCapabilities: (
    resources: DiscoveredResource[],
    options?: InferenceOptions
  ) => Promise<ResourceCapability[]>;
  /** Storage function — embeds and stores capabilities in vector DB */
  storeCapabilities: (
    capabilities: ResourceCapability[],
    vectorStore: VectorStore,
    options?: StorageOptions
  ) => Promise<void>;
}

/**
 * Creates the capabilities route group with the scan endpoint.
 *
 * Uses a factory function so all dependencies can be injected —
 * same pattern as createInstancesRoute(). Tests pass mocks, the CLI
 * subcommand passes real pipeline functions and ChromaBackend.
 *
 * @param deps - Injected dependencies for the pipeline
 * @returns Hono app with the scan route mounted
 */
export function createCapabilitiesRoute(deps: CapabilitiesRouteDeps): Hono {
  const route = new Hono();

  /**
   * POST /api/v1/capabilities/scan
   *
   * Accepts the controller's JSON payload with CRD names to scan/delete.
   * Validates synchronously, returns 202 immediately, then processes
   * in the background.
   *
   * Response codes:
   * - 202: Accepted (controller moves on, processing happens in background)
   * - 400: Bad request (controller does NOT retry — payload is invalid)
   */
  route.post(
    "/",
    zValidator("json", ScanPayloadSchema, (result, c) => {
      if (!result.success) {
        return c.json(
          { error: "Invalid payload", details: result.error.issues },
          400
        );
      }
    }),
    async (c) => {
      const payload = c.req.valid("json");

      // Suppress progress logging in HTTP context (no stdout in a server)
      const silentProgress = () => {};

      // Fire-and-forget: process deletes and upserts in the background.
      // The controller's job is done once it receives 202.
      // Pipeline failures surface via OTel spans, not HTTP responses.
      processInBackground(deps, payload, silentProgress);

      return c.json(
        {
          status: "accepted",
          upserts: payload.upserts.length,
          deletes: payload.deletes.length,
        },
        202
      );
    }
  );

  return route;
}

/**
 * Processes the scan payload in the background.
 *
 * Runs deletes first (fast — just a vector store call), then the
 * full upsert pipeline (discover → infer → store). Errors are logged
 * but not propagated — the HTTP response has already been sent.
 */
function processInBackground(
  deps: CapabilitiesRouteDeps,
  payload: { upserts: string[]; deletes: string[] },
  onProgress: (message: string) => void
): void {
  // Use void to explicitly discard the promise (fire-and-forget)
  void (async () => {
    // Process deletes first
    if (payload.deletes.length > 0) {
      try {
        await deps.vectorStore.delete(
          CAPABILITIES_COLLECTION,
          payload.deletes
        );
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error);
        // eslint-disable-next-line no-console
        console.error(
          `Capability scan: delete failed: ${message}`
        );
      }
    }

    // Process upserts through the pipeline
    if (payload.upserts.length > 0) {
      try {
        const discovered = await deps.discoverResources({
          resourceNames: payload.upserts,
          onProgress,
        });

        const capabilities = await deps.inferCapabilities(discovered, {
          onProgress,
        });

        await deps.storeCapabilities(capabilities, deps.vectorStore, {
          onProgress,
        });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error);
        // eslint-disable-next-line no-console
        console.error(
          `Capability scan: upsert pipeline failed: ${message}`
        );
      }
    }
  })();
}
