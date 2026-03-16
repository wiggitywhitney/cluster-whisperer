// ABOUTME: Tests for file-backed checkpointer — verifies save/load round-trip,
// ABOUTME: missing file handling, and corrupt file recovery.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { loadCheckpointer, saveCheckpointer } from "./file-checkpointer";

describe("file-checkpointer", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cw-checkpointer-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns a fresh MemorySaver when no prior thread file exists", () => {
    const checkpointer = loadCheckpointer("new-thread", tmpDir);
    expect(checkpointer).toBeDefined();
    expect(Object.keys(checkpointer.storage)).toHaveLength(0);
  });

  it("round-trips storage data through save and load", () => {
    const checkpointer = loadCheckpointer("test-thread", tmpDir);

    // Simulate some state being stored by the agent
    checkpointer.storage["some-key"] = { data: "test-value" };
    checkpointer.writes["write-key"] = { data: "write-value" };

    saveCheckpointer(checkpointer, "test-thread", tmpDir);

    // Load a fresh checkpointer for the same thread — state should be restored
    const restored = loadCheckpointer("test-thread", tmpDir);
    expect(restored.storage["some-key"]).toEqual({ data: "test-value" });
    expect(restored.writes["write-key"]).toEqual({ data: "write-value" });
  });

  it("creates the threads directory if it does not exist", () => {
    const nestedDir = path.join(tmpDir, "nested", "threads");
    const checkpointer = loadCheckpointer("test", nestedDir);
    checkpointer.storage["key"] = "value";

    saveCheckpointer(checkpointer, "test", nestedDir);

    expect(fs.existsSync(path.join(nestedDir, "test.json"))).toBe(true);
  });

  it("sanitizes thread IDs for filesystem safety", () => {
    const checkpointer = loadCheckpointer("thread/with:special chars!", tmpDir);
    checkpointer.storage["key"] = "value";

    saveCheckpointer(checkpointer, "thread/with:special chars!", tmpDir);

    // Should create a file with sanitized name
    const files = fs.readdirSync(tmpDir);
    expect(files).toHaveLength(1);
    expect(files[0]).not.toContain("/");
    expect(files[0]).not.toContain(":");
  });

  it("handles corrupt JSON files gracefully", () => {
    // Write corrupt data
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "bad-thread.json"), "not valid json{{{");

    // Should not throw — returns a fresh checkpointer
    const checkpointer = loadCheckpointer("bad-thread", tmpDir);
    expect(checkpointer).toBeDefined();
    expect(Object.keys(checkpointer.storage)).toHaveLength(0);
  });

  it("different thread IDs have independent state", () => {
    const cp1 = loadCheckpointer("thread-a", tmpDir);
    cp1.storage["key"] = "value-a";
    saveCheckpointer(cp1, "thread-a", tmpDir);

    const cp2 = loadCheckpointer("thread-b", tmpDir);
    cp2.storage["key"] = "value-b";
    saveCheckpointer(cp2, "thread-b", tmpDir);

    const restored1 = loadCheckpointer("thread-a", tmpDir);
    const restored2 = loadCheckpointer("thread-b", tmpDir);
    expect(restored1.storage["key"]).toBe("value-a");
    expect(restored2.storage["key"]).toBe("value-b");
  });
});
