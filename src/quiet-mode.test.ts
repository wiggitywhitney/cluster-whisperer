// ABOUTME: Tests for quiet mode utility.
// ABOUTME: Verifies CLUSTER_WHISPERER_QUIET env var controls debug output suppression.

import { describe, it, expect, beforeEach, afterEach } from "vitest";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  delete process.env.CLUSTER_WHISPERER_QUIET;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("isQuietMode", () => {
  it("returns false when CLUSTER_WHISPERER_QUIET is unset", async () => {
    const { isQuietMode } = await import("./quiet-mode");
    expect(isQuietMode()).toBe(false);
  });

  it("returns true when CLUSTER_WHISPERER_QUIET=true", async () => {
    process.env.CLUSTER_WHISPERER_QUIET = "true";
    const { isQuietMode } = await import("./quiet-mode");
    expect(isQuietMode()).toBe(true);
  });

  it("returns false for non-true values like 'yes'", async () => {
    process.env.CLUSTER_WHISPERER_QUIET = "yes";
    const { isQuietMode } = await import("./quiet-mode");
    expect(isQuietMode()).toBe(false);
  });

  it("returns true when CLUSTER_WHISPERER_QUIET=1", async () => {
    process.env.CLUSTER_WHISPERER_QUIET = "1";
    const { isQuietMode } = await import("./quiet-mode");
    expect(isQuietMode()).toBe(true);
  });
});
