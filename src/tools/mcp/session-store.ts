// ABOUTME: In-memory session store for kubectl_apply_dryrun session state
// ABOUTME: Holds one pending manifest at a time; new dry-run replaces the previous session

import { randomUUID } from "crypto";

/**
 * SessionStore — application-layer gate for kubectl_apply
 *
 * This is Layer 2 in the PRD #120 guardrails design. The AI coding assistant
 * cannot pass arbitrary YAML to kubectl_apply at invocation time — it can only
 * reference a manifest that was already validated via kubectl_apply_dryrun.
 *
 * Semantics:
 * - One pending session at a time. A new dry-run replaces the previous session,
 *   invalidating the old session ID.
 * - Sessions are single-use: consume() removes the session after reading.
 * - No TTL — sessions are process-scoped. When the MCP server disconnects, all
 *   sessions are gone.
 */
export class SessionStore {
  private sessions: Map<string, string> = new Map();

  /**
   * Store a manifest and return a new session ID.
   *
   * Clears any previous session first — only one pending apply at a time.
   * The returned session ID is required by kubectl_apply.
   *
   * @param manifest - The YAML manifest that passed dry-run validation
   * @returns A UUID session ID to pass to kubectl_apply
   */
  store(manifest: string): string {
    // One pending apply at a time — clear any previous sessions
    this.sessions.clear();
    const sessionId = randomUUID();
    this.sessions.set(sessionId, manifest);
    return sessionId;
  }

  /**
   * Read and consume a session — single use only.
   *
   * Returns the manifest and deletes the session. A second call with the
   * same session ID returns undefined (session already consumed).
   *
   * @param sessionId - The session ID returned by kubectl_apply_dryrun
   * @returns The stored manifest, or undefined if not found or already consumed
   */
  consume(sessionId: string): string | undefined {
    const manifest = this.sessions.get(sessionId);
    if (manifest !== undefined) {
      this.sessions.delete(sessionId);
    }
    return manifest;
  }

  /**
   * Read a session without consuming it.
   *
   * Used internally for testing and inspection. Does not affect session state.
   *
   * @param sessionId - The session ID to look up
   * @returns The stored manifest, or undefined if not found
   */
  peek(sessionId: string): string | undefined {
    return this.sessions.get(sessionId);
  }
}
