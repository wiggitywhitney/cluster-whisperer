// ABOUTME: Unit tests for truncateToolResult — verifies head+tail truncation for LLM context safety.
// ABOUTME: Tests no-op for short text, correct splitting for long text, and custom limits.

import { describe, it, expect } from "vitest";
import { truncateToolResult } from "./truncate";

describe("truncateToolResult", () => {
  it("returns text unchanged when under the limit", () => {
    const short = "NAME   READY   STATUS\nnginx  1/1     Running\n";
    expect(truncateToolResult(short)).toBe(short);
  });

  it("returns text unchanged when exactly at the limit", () => {
    const exact = "x".repeat(50000);
    expect(truncateToolResult(exact)).toBe(exact);
  });

  it("truncates text over the limit with head + tail", () => {
    const long = "H".repeat(30000) + "M".repeat(40000) + "T".repeat(30000);
    const result = truncateToolResult(long);

    expect(result.length).toBeLessThan(long.length);
    // Head should start with H's
    expect(result.startsWith("H")).toBe(true);
    // Tail should end with T's
    expect(result.endsWith("T")).toBe(true);
    // Separator message should be present
    expect(result).toContain("characters omitted to fit context window");
  });

  it("preserves roughly equal head and tail portions", () => {
    const long = "A".repeat(60000);
    const result = truncateToolResult(long);

    // Split on the separator
    const parts = result.split("characters omitted to fit context window");
    expect(parts).toHaveLength(2);

    // Both parts should have substantial content
    const headPart = parts[0];
    const tailPart = parts[1];
    expect(headPart.length).toBeGreaterThan(20000);
    expect(tailPart.length).toBeGreaterThan(20000);
  });

  it("includes the correct omitted character count in the separator", () => {
    // 70K chars, limit 50K, separator ~100 chars → keep ~24,950 each side
    // omitted = 70000 - 2*24950 = 20100
    const long = "x".repeat(70000);
    const result = truncateToolResult(long);

    // Extract the number from the separator
    const match = result.match(/(\d+) characters omitted/);
    expect(match).not.toBeNull();
    const omitted = parseInt(match![1], 10);
    // Should be roughly 20K (70K - 50K)
    expect(omitted).toBeGreaterThan(19000);
    expect(omitted).toBeLessThan(21000);
  });

  it("respects a custom maxChars limit", () => {
    const text = "x".repeat(2000);
    const result = truncateToolResult(text, 1000);

    expect(result.length).toBeLessThan(2000);
    expect(result).toContain("characters omitted");
  });

  it("does not truncate when custom limit is larger than text", () => {
    const text = "x".repeat(200);
    expect(truncateToolResult(text, 300)).toBe(text);
  });
});
