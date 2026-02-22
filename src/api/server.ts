/**
 * server.ts - HTTP server for receiving instance sync payloads (PRD #35)
 *
 * What this file does:
 * Creates a Hono web application that exposes health probes and (in M2+)
 * the sync endpoint for receiving pushed instance data from the
 * k8s-vectordb-sync controller.
 *
 * Why Hono:
 * ~13KB minified with zero dependencies. First-class Zod integration via
 * @hono/zod-validator. Web Standards (Fetch API) for portability.
 * Proportional to scope — one POST route plus health checks.
 *
 * Architecture:
 * - createApp() is a factory that accepts dependencies (VectorStore) and
 *   returns a Hono app. This makes the app testable via app.request()
 *   without starting a real server.
 * - startServer() wraps the app in a Node.js HTTP server via @hono/node-server.
 *   Only the CLI subcommand calls this.
 */

import { Hono } from "hono";
import { serve, type ServerType } from "@hono/node-server";
import type { VectorStore } from "../vectorstore";

/**
 * Dependencies injected into the Hono app.
 *
 * The factory pattern lets tests pass a mock VectorStore while the CLI
 * subcommand passes a real ChromaBackend + VoyageEmbedding.
 */
export interface ServerDependencies {
  /** Vector store used for readiness probe (and sync endpoint in M2+) */
  vectorStore: VectorStore;
}

/**
 * Creates the Hono app with health probe routes.
 *
 * Routes:
 * - GET /healthz — liveness probe; always returns 200 if the process is running
 * - GET /readyz  — readiness probe; returns 200 only when ChromaDB is reachable
 *
 * @param deps - Injected dependencies (vector store for readiness check)
 * @returns Configured Hono app (call app.request() for testing, or pass to startServer())
 */
export function createApp(deps: ServerDependencies): Hono {
  const app = new Hono({ strict: false });

  /**
   * Liveness probe — "is the process alive?"
   *
   * Kubernetes calls this to decide whether to restart the container.
   * Always returns 200 because if this handler executes, the process is alive.
   * No dependency checks here — that's what readiness is for.
   */
  app.get("/healthz", (c) => {
    return c.json({ status: "ok" });
  });

  /**
   * Readiness probe — "can the process serve traffic?"
   *
   * Kubernetes calls this to decide whether to route traffic to this pod.
   * Returns 200 only when ChromaDB is reachable — if the vector DB is down,
   * the sync endpoint can't process payloads, so we shouldn't receive them.
   *
   * Uses vectorStore.initialize() as a lightweight connectivity check.
   * initialize() is idempotent (getOrCreateCollection), so calling it
   * repeatedly is safe.
   */
  app.get("/readyz", async (c) => {
    try {
      await deps.vectorStore.initialize("instances", {
        distanceMetric: "cosine",
      });
      return c.json({ status: "ok" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return c.json({ status: "unavailable", error: message }, 503);
    }
  });

  return app;
}

/**
 * Options for starting the HTTP server.
 */
export interface StartServerOptions {
  /** Port to listen on (default: 3000) */
  port: number;
}

/**
 * Starts the Hono app as a Node.js HTTP server.
 *
 * Only called from the CLI subcommand — never in tests.
 * Returns the underlying http.Server for graceful shutdown.
 *
 * @param app - The Hono app from createApp()
 * @param options - Server configuration (port)
 * @returns Node.js HTTP server instance (supports .close() for graceful shutdown)
 */
export function startServer(app: Hono, options: StartServerOptions): ServerType {
  const server = serve({
    fetch: app.fetch,
    port: options.port,
  });

  console.log(`Server listening on port ${options.port}`); // eslint-disable-line no-console
  console.log(`  Liveness:  http://localhost:${options.port}/healthz`); // eslint-disable-line no-console
  console.log(`  Readiness: http://localhost:${options.port}/readyz`); // eslint-disable-line no-console

  return server;
}
