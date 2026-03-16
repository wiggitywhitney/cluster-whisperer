// ABOUTME: File-backed checkpointer that wraps MemorySaver with JSON persistence.
// ABOUTME: Enables multi-turn CLI conversations by saving/loading thread state between invocations.

/**
 * file-checkpointer.ts - Persistent conversation memory for the CLI agent
 *
 * Why not @langchain/langgraph-checkpoint-sqlite?
 * That package requires @langchain/langgraph-checkpoint ^0.1.0, but our
 * @langchain/langgraph@0.2.74 bundles checkpoint 0.0.18. Rather than
 * upgrading the entire LangGraph stack (risky before a demo), we wrap
 * MemorySaver with file-based persistence. The agent uses MemorySaver
 * in-memory during a run, and we serialize/deserialize its internal
 * storage to a JSON file between CLI invocations.
 *
 * How it works:
 * 1. On startup: load the JSON file into a fresh MemorySaver
 * 2. Agent runs normally using the MemorySaver checkpointer
 * 3. On shutdown: serialize MemorySaver's storage back to the JSON file
 *
 * Binary data handling:
 * MemorySaver's internal storage contains Uint8Array values (serialized
 * LangGraph state). Plain JSON.stringify converts these to objects like
 * {"0":123,"1":34,...} which lose their type. We use a custom replacer/
 * reviver that encodes Uint8Array as base64 strings with a type marker,
 * preserving binary data across save/load cycles.
 */

import { MemorySaver } from "@langchain/langgraph";
import * as fs from "fs";
import * as path from "path";

/** Default directory for thread checkpoint files */
const DEFAULT_THREADS_DIR = path.join(process.cwd(), "data", "threads");

/** Marker prefix for base64-encoded Uint8Array values in JSON */
const UINT8_MARKER = "__uint8__:";

/**
 * JSON replacer that converts Uint8Array to base64 strings with a type marker.
 * This preserves binary checkpoint data through JSON serialization.
 */
function binaryReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Uint8Array) {
    return UINT8_MARKER + Buffer.from(value).toString("base64");
  }
  return value;
}

/**
 * JSON reviver that converts base64-marked strings back to Uint8Array.
 * Reverses the binaryReplacer transformation on load.
 */
function binaryReviver(_key: string, value: unknown): unknown {
  if (typeof value === "string" && value.startsWith(UINT8_MARKER)) {
    const base64 = value.slice(UINT8_MARKER.length);
    return new Uint8Array(Buffer.from(base64, "base64"));
  }
  return value;
}

/**
 * Creates a MemorySaver pre-populated with checkpoint data from a file.
 *
 * @param threadId - The conversation thread ID
 * @param threadsDir - Directory to store thread files (default: data/threads/)
 * @returns A MemorySaver with any prior conversation state loaded
 */
export function loadCheckpointer(
  threadId: string,
  threadsDir: string = DEFAULT_THREADS_DIR
): MemorySaver {
  const checkpointer = new MemorySaver();
  const filePath = getThreadFilePath(threadId, threadsDir);

  if (fs.existsSync(filePath)) {
    try {
      const data = JSON.parse(
        fs.readFileSync(filePath, "utf-8"),
        binaryReviver
      );
      // Restore internal storage and writes from the saved state
      if (data.storage) {
        Object.assign(checkpointer.storage, data.storage);
      }
      if (data.writes) {
        Object.assign(checkpointer.writes, data.writes);
      }
    } catch {
      // Corrupt file — start fresh. The old thread data is lost but
      // the agent still works (just without prior conversation context).
    }
  }

  return checkpointer;
}

/**
 * Saves a MemorySaver's state to a file for later restoration.
 *
 * Call this after the agent finishes to persist the conversation.
 *
 * @param checkpointer - The MemorySaver to persist
 * @param threadId - The conversation thread ID
 * @param threadsDir - Directory to store thread files (default: data/threads/)
 */
export function saveCheckpointer(
  checkpointer: MemorySaver,
  threadId: string,
  threadsDir: string = DEFAULT_THREADS_DIR
): void {
  const filePath = getThreadFilePath(threadId, threadsDir);

  // Ensure the directory exists
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  const data = {
    threadId,
    savedAt: new Date().toISOString(),
    storage: checkpointer.storage,
    writes: checkpointer.writes,
  };

  fs.writeFileSync(filePath, JSON.stringify(data, binaryReplacer), "utf-8");
}

/**
 * Returns the file path for a thread's checkpoint data.
 * Each thread gets its own JSON file.
 */
function getThreadFilePath(threadId: string, threadsDir: string): string {
  // Sanitize thread ID for filesystem safety
  const safeId = threadId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(threadsDir, `${safeId}.json`);
}
