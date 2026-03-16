// ABOUTME: Tests for Vercel agent thread store — verifies save/load round-trip,
// ABOUTME: missing file handling, corrupt file recovery, and thread isolation.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import type { ModelMessage } from "ai";
import { loadVercelThread, saveVercelThread } from "./vercel-thread-store";

describe("vercel-thread-store", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cw-vercel-thread-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns an empty array when no prior thread file exists", () => {
    const messages = loadVercelThread("new-thread", tmpDir);
    expect(messages).toEqual([]);
  });

  it("round-trips ModelMessage[] through save and load", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "What pods are running?" },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "kubectl_get",
            args: { resource: "pods" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "kubectl_get",
            result: "pod-1  Running",
          },
        ],
      },
      { role: "assistant", content: "There is one pod running: pod-1." },
    ];

    saveVercelThread(messages, "test-thread", tmpDir);

    const restored = loadVercelThread("test-thread", tmpDir);
    expect(restored).toEqual(messages);
  });

  it("creates the threads directory if it does not exist", () => {
    const nestedDir = path.join(tmpDir, "nested", "threads");
    const messages: ModelMessage[] = [
      { role: "user", content: "test" },
    ];

    saveVercelThread(messages, "test", nestedDir);

    expect(fs.existsSync(path.join(nestedDir, "vercel-test.json"))).toBe(true);
  });

  it("uses vercel- prefix in file naming to avoid LangGraph collisions", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "test" },
    ];

    saveVercelThread(messages, "my-thread", tmpDir);

    const files = fs.readdirSync(tmpDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toBe("vercel-my-thread.json");
  });

  it("sanitizes thread IDs for filesystem safety", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "test" },
    ];

    saveVercelThread(messages, "thread/with:special chars!", tmpDir);

    const files = fs.readdirSync(tmpDir);
    expect(files).toHaveLength(1);
    expect(files[0]).not.toContain("/");
    expect(files[0]).not.toContain(":");
    expect(files[0]).toMatch(/^vercel-/);
  });

  it("handles corrupt JSON files gracefully", () => {
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, "vercel-bad-thread.json"),
      "not valid json{{{"
    );

    const messages = loadVercelThread("bad-thread", tmpDir);
    expect(messages).toEqual([]);
  });

  it("different thread IDs have independent state", () => {
    const messagesA: ModelMessage[] = [
      { role: "user", content: "question A" },
    ];
    const messagesB: ModelMessage[] = [
      { role: "user", content: "question B" },
    ];

    saveVercelThread(messagesA, "thread-a", tmpDir);
    saveVercelThread(messagesB, "thread-b", tmpDir);

    const restoredA = loadVercelThread("thread-a", tmpDir);
    const restoredB = loadVercelThread("thread-b", tmpDir);
    expect(restoredA).toEqual(messagesA);
    expect(restoredB).toEqual(messagesB);
  });

  it("saves valid JSON that can be inspected manually", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi there" },
    ];

    saveVercelThread(messages, "inspect-thread", tmpDir);

    const raw = fs.readFileSync(
      path.join(tmpDir, "vercel-inspect-thread.json"),
      "utf-8"
    );
    const parsed = JSON.parse(raw);
    expect(parsed).toEqual(messages);
    // Verify pretty-printed (indented) for human readability
    expect(raw).toContain("\n");
  });
});
