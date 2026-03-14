// ABOUTME: Sync endpoint route handler for receiving instance data from k8s-vectordb-sync controller
// ABOUTME: Validates payload with Zod, processes deletes then upserts, returns status codes for retry logic

/**
 * instances.ts - Sync endpoint route handler (PRD #35 M2–M3)
 *
 * Receives batched instance changes from the k8s-vectordb-sync controller
 * and stores them in the vector database via existing pipeline functions.
 *
 * This is a thin wrapper: validate (Zod), delegate (pipeline), respond
 * (status code). No business logic lives here — the heavy lifting is in
 * instanceToDocument(), storeInstances(), and vectorStore.delete().
 *
 * Processing order: deletes first, then upserts. If the same ID appears
 * in both arrays, the delete removes it and the upsert recreates it.
 */

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { trace } from "@opentelemetry/api";
import { SyncPayloadSchema } from "../schemas/sync-payload";
import { storeInstances } from "../../pipeline/instance-storage";
import { INSTANCES_COLLECTION } from "../../vectorstore";
import type { VectorStore } from "../../vectorstore";
import type { ResourceInstance } from "../../pipeline/types";

/**
 * Creates the instances route group with the sync endpoint.
 *
 * Uses a factory function so the VectorStore dependency can be injected —
 * same pattern as createApp() in server.ts. Tests pass a mock, the CLI
 * subcommand passes a real ChromaBackend.
 *
 * @param vectorStore - Injected VectorStore for storing instances
 * @returns Hono app with the sync route mounted
 */
export function createInstancesRoute(vectorStore: VectorStore): Hono {
  const route = new Hono();

  /**
   * POST /api/v1/instances/sync
   *
   * Accepts the controller's JSON payload with upserts and deletes arrays.
   * Validates with Zod, processes upserts through the existing pipeline,
   * and returns appropriate status codes for the controller's retry logic.
   *
   * Response codes:
   * - 200: Success (controller moves on)
   * - 400: Bad request (controller does NOT retry — payload is invalid)
   * - 500: Server error (controller retries with exponential backoff)
   */
  route.post(
    "/",
    zValidator("json", SyncPayloadSchema, (result, c) => {
      if (!result.success) {
        return c.json(
          { error: "Invalid payload", details: result.error.issues },
          400
        );
      }
    }),
    async (c) => {
      const payload = c.req.valid("json");

      try {
        // Ensure collection exists before any operations — prevents
        // "Collection has not been initialized" when the first request
        // includes deletes before any readiness probe has run.
        await vectorStore.initialize(INSTANCES_COLLECTION, {
          distanceMetric: "cosine",
        });

        // Process deletes first — if the same ID appears in both arrays,
        // the delete removes it and the upsert recreates it below
        if (payload.deletes.length > 0) {
          await vectorStore.delete(INSTANCES_COLLECTION, payload.deletes);
        }

        // Cast validated payload to ResourceInstance[] — Zod schema matches the type
        const instances = payload.upserts as ResourceInstance[];

        // Suppress progress logging in HTTP context (no stdout in a server)
        const silentProgress = () => {};

        await storeInstances(instances, vectorStore, {
          onProgress: silentProgress,
        });

        // Set custom OTel attributes on the active HTTP span (PRD #37 M5).
        // The tracing middleware creates the span; we enrich it with
        // sync-specific counts for observability.
        const activeSpan = trace.getActiveSpan();
        if (activeSpan) {
          activeSpan.setAttribute(
            "cluster_whisperer.sync.upsert_count",
            payload.upserts.length
          );
          activeSpan.setAttribute(
            "cluster_whisperer.sync.delete_count",
            payload.deletes.length
          );
        }

        return c.json({
          status: "ok",
          upserted: payload.upserts.length,
          deleted: payload.deletes.length,
        });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error);
        return c.json({ error: message }, 500);
      }
    }
  );

  return route;
}
