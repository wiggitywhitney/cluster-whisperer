// ABOUTME: Hono web server factory for the demo app. Accepts a pg Pool and exposes
// ABOUTME: routes for health checks and database connectivity status.

import { Hono } from "hono";
import type { Pool } from "pg";

/** Dependencies injected into the app factory for testability. */
export interface AppDependencies {
  pool: Pool | null;
}

/**
 * Creates the Hono application with all routes.
 * Accepts dependencies so the app can be tested without real database connections.
 */
export function createApp(deps: AppDependencies): Hono {
  const app = new Hono();

  /**
   * Liveness probe — returns 200 if the process is running.
   * Independent of database state so Kubernetes doesn't kill the pod
   * just because the DB is unreachable.
   */
  app.get("/healthz", (c) => {
    return c.json({ status: "ok" });
  });

  /**
   * Root route — reports whether the database is reachable.
   * Returns 200 + connected when the DB responds to a simple query,
   * or 503 + disconnected when it doesn't.
   */
  app.get("/", async (c) => {
    if (!deps.pool) {
      return c.json({ status: "disconnected", database: false }, 503);
    }

    try {
      await deps.pool.query("SELECT 1");
      return c.json({ status: "connected", database: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json(
        { status: "disconnected", database: false, error: message },
        503
      );
    }
  });

  return app;
}

/**
 * Checks database connectivity by running a simple query.
 * Throws if the connection fails — used during startup to crash fast.
 */
export async function checkDatabaseConnection(pool: Pool): Promise<void> {
  await pool.query("SELECT 1");
}

/**
 * Formats a startup error message for kubectl logs.
 * Designed to be agent-friendly: single-line, includes "database" keyword,
 * and shows the connection target so the agent knows what service is missing.
 */
export function formatStartupError(databaseUrl: string, error: Error): string {
  return `[demo-app] FATAL: Cannot connect to database at ${databaseUrl} - ${error.message}`;
}
