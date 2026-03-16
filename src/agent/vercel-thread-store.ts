// ABOUTME: File-backed thread store for Vercel agent conversation memory.
// ABOUTME: Saves/loads ModelMessage[] to JSON files, enabling multi-turn CLI conversations.

/**
 * vercel-thread-store.ts - Persistent conversation memory for the Vercel agent
 *
 * Unlike the LangGraph agent's file-checkpointer (which wraps MemorySaver with
 * binary serialization), the Vercel agent stores plain ModelMessage[] arrays.
 * These are JSON-serializable without special encoding — no base64 or Uint8Array
 * handling needed.
 *
 * How it works:
 * 1. Before investigation: loadVercelThread() reads prior messages from disk
 * 2. Agent runs with those messages as conversation history
 * 3. After investigation: saveVercelThread() writes the full history to disk
 *
 * File naming uses a "vercel-" prefix to avoid collision with LangGraph thread
 * files in the same data/threads/ directory.
 */

import * as fs from "fs";
import * as path from "path";
import type { ModelMessage } from "ai";

/** Default directory for thread files — shared with LangGraph checkpointer */
const DEFAULT_THREADS_DIR = path.join(process.cwd(), "data", "threads");

/**
 * Load prior conversation messages for a thread.
 *
 * Returns an empty array if the file doesn't exist or contains invalid JSON.
 * This "start fresh" behavior matches the LangGraph file-checkpointer pattern.
 *
 * @param threadId - The conversation thread ID
 * @param threadsDir - Directory for thread files (default: data/threads/)
 * @returns The stored ModelMessage array, or empty array if none
 */
export function loadVercelThread(
  threadId: string,
  threadsDir: string = DEFAULT_THREADS_DIR
): ModelMessage[] {
  const filePath = getThreadFilePath(threadId, threadsDir);

  if (!fs.existsSync(filePath)) {
    return [];
  }

  try {
    const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    if (Array.isArray(data)) {
      return data as ModelMessage[];
    }
    return [];
  } catch {
    // Corrupt file — start fresh. Same recovery pattern as file-checkpointer.
    return [];
  }
}

/**
 * Save conversation messages for a thread.
 *
 * Writes the full message history as pretty-printed JSON for human readability.
 * ModelMessage objects are plain JSON-serializable — no special encoding needed.
 *
 * @param messages - The full conversation history to persist
 * @param threadId - The conversation thread ID
 * @param threadsDir - Directory for thread files (default: data/threads/)
 */
export function saveVercelThread(
  messages: ModelMessage[],
  threadId: string,
  threadsDir: string = DEFAULT_THREADS_DIR
): void {
  const filePath = getThreadFilePath(threadId, threadsDir);

  // Ensure the directory exists
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  fs.writeFileSync(filePath, JSON.stringify(messages, null, 2), "utf-8");
}

/**
 * Returns the file path for a Vercel thread's message history.
 *
 * Uses "vercel-" prefix to avoid collision with LangGraph thread files
 * (which are named <threadId>.json without a prefix).
 */
function getThreadFilePath(threadId: string, threadsDir: string): string {
  const safeId = threadId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(threadsDir, `vercel-${safeId}.json`);
}
