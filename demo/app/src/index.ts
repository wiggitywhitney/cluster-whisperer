// ABOUTME: Entry point for the demo app. Reads DATABASE_URL, attempts a database
// ABOUTME: connection, and either starts the Hono server or crashes with a clear error.

import { serve } from "@hono/node-server";
import pg from "pg";
import { createApp, checkDatabaseConnection, formatStartupError } from "./server.js";

const PORT = parseInt(process.env.PORT || "3000", 10);
const DATABASE_URL = process.env.DATABASE_URL;

/**
 * Main startup function. This is the heart of the demo app's behavior:
 * - No DATABASE_URL → crash immediately with a clear error
 * - DATABASE_URL set but unreachable → crash immediately with connection error
 * - DATABASE_URL set and reachable → start serving HTTP traffic
 *
 * The "crash immediately" behavior is intentional. In the demo, the app runs in
 * Kubernetes without a database, producing CrashLoopBackOff. The agent investigates
 * why the app is crashing and discovers the missing database.
 */
async function main(): Promise<void> {
  console.log("[demo-app] Starting server..."); // eslint-disable-line no-console

  if (!DATABASE_URL) {
    console.error(
      "[demo-app] FATAL: DATABASE_URL environment variable is required"
    );
    console.error("[demo-app] Exiting with code 1");
    process.exit(1);
  }

  console.log( // eslint-disable-line no-console
    `[demo-app] Connecting to backend service at ${DATABASE_URL}...`
  );

  const pool = new pg.Pool({
    connectionString: DATABASE_URL,
    connectionTimeoutMillis: 5000,
  });

  try {
    await checkDatabaseConnection(pool);
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    console.error(formatStartupError(DATABASE_URL, error));
    console.error("[demo-app] Exiting with code 1");
    process.exit(1);
  }

  console.log("[demo-app] Database connection established"); // eslint-disable-line no-console

  const app = createApp({ pool });

  serve({ fetch: app.fetch, port: PORT }, () => {
    console.log(`[demo-app] Server listening on port ${PORT}`); // eslint-disable-line no-console
  });
}

main();
