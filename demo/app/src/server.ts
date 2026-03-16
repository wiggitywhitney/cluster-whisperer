// ABOUTME: Hono web server factory for the demo app. Accepts a pg Pool and exposes
// ABOUTME: routes for health checks and database connectivity status.

import { Hono } from "hono";
import type { Pool } from "pg";
import * as fs from "fs";
import * as path from "path";

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
   * Root route — serves the spider page with clickable YouTube links.
   * Top half of the spider links to Whitney's YouTube, bottom half to Viktor's.
   * The app only reaches this route if the database was reachable at startup
   * (otherwise the process crashes before serving any requests).
   */
  app.get("/", (c) => {
    return c.html(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>cluster-whisperer demo</title>
  <style>
    body {
      margin: 0;
      background: #1a1a2e;
      display: flex;
      justify-content: center;
      align-items: center;
      min-height: 100vh;
    }
    .container {
      position: relative;
      display: inline-block;
    }
    .container img {
      max-height: 90vh;
      max-width: 90vw;
      display: block;
    }
    .zone {
      position: absolute;
      left: 0;
      width: 100%;
      height: 50%;
      display: block;
    }
    .zone-top { top: 0; }
    .zone-bottom { top: 50%; }
  </style>
</head>
<body>
  <div class="container">
    <img src="/Spider-v3.png" alt="Spider">
    <a class="zone zone-top" href="https://www.youtube.com/@wiggitywhitney" target="_blank" rel="noopener"></a>
    <a class="zone zone-bottom" href="https://www.youtube.com/@DevOpsToolkit" target="_blank" rel="noopener"></a>
  </div>
</body>
</html>`);
  });

  /**
   * Serve the spider image from the public directory.
   * Single static asset — no middleware needed.
   */
  app.get("/Spider-v3.png", (c) => {
    const imagePath = path.join(__dirname, "../public/Spider-v3.png");
    try {
      const imageBuffer = fs.readFileSync(imagePath);
      return new Response(imageBuffer, {
        headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=86400" },
      });
    } catch {
      return c.text("Image not found", 404);
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
 * Designed to be agent-friendly: single-line, shows the connection target so
 * the agent knows what service is missing. Intentionally generic — does not
 * reveal the service type (database, cache, etc.) so the agent must use
 * semantic search to discover the right platform resource.
 */
export function formatStartupError(databaseUrl: string, error: Error): string {
  return `[demo-app] FATAL: Cannot connect to required backend service at ${databaseUrl} - ${error.message}`;
}
