// ABOUTME: Unit tests for tool-group parsing and validation
// ABOUTME: Verifies --tools flag parsing, defaults, and error handling

/**
 * Tests for the tool-group parsing module.
 *
 * The --tools CLI flag accepts comma-separated group names that control
 * which tools the agent has access to. These tests verify:
 * - Valid groups are accepted and parsed correctly
 * - Invalid groups produce helpful error messages
 * - The default tool set is backwards compatible (kubectl,vector)
 * - Edge cases like whitespace and empty strings are handled
 */

import { describe, it, expect } from "vitest";
import {
  parseToolGroups,
  VALID_TOOL_GROUPS,
  DEFAULT_TOOL_GROUPS,
  type ToolGroup,
} from "./tool-groups";

describe("parseToolGroups", () => {
  it("parses a single valid group", () => {
    expect(parseToolGroups("kubectl")).toEqual(["kubectl"]);
  });

  it("parses multiple comma-separated groups", () => {
    expect(parseToolGroups("kubectl,vector,apply")).toEqual([
      "kubectl",
      "vector",
      "apply",
    ]);
  });

  it("trims whitespace around group names", () => {
    expect(parseToolGroups(" kubectl , vector ")).toEqual([
      "kubectl",
      "vector",
    ]);
  });

  it("deduplicates repeated groups", () => {
    expect(parseToolGroups("kubectl,kubectl,vector")).toEqual([
      "kubectl",
      "vector",
    ]);
  });

  it("throws on invalid group name", () => {
    expect(() => parseToolGroups("kubectl,bogus")).toThrow(
      /Unknown tool group: "bogus"/
    );
  });

  it("throws on empty string", () => {
    expect(() => parseToolGroups("")).toThrow(/at least one tool group/i);
  });

  it("throws on whitespace-only string", () => {
    expect(() => parseToolGroups("   ")).toThrow(/at least one tool group/i);
  });
});

describe("VALID_TOOL_GROUPS", () => {
  it("contains kubectl, vector, and apply", () => {
    expect(VALID_TOOL_GROUPS).toEqual(["kubectl", "vector", "apply"]);
  });
});

describe("DEFAULT_TOOL_GROUPS", () => {
  it("defaults to kubectl and vector for backwards compatibility", () => {
    expect(DEFAULT_TOOL_GROUPS).toEqual(["kubectl", "vector"]);
  });
});
