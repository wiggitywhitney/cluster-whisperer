// ABOUTME: Unit tests for system prompt loading and tool-section stripping.
// ABOUTME: Verifies that inactive tool group sections are removed from the prompt.

/**
 * Tests for the system-prompt module.
 *
 * The buildSystemPrompt function strips HTML-comment-tagged sections from the
 * investigator prompt based on which tool groups are active. This prevents
 * the agent from reasoning about tools it doesn't have access to — which was
 * causing demo spoilers when running in kubectl-only mode.
 *
 * Tests use stripInactiveSections directly (pure function, no file I/O)
 * so they run without a real investigator.md present.
 */

import { describe, it, expect } from "vitest";
import { stripInactiveSections } from "./system-prompt";

describe("stripInactiveSections", () => {
  it("removes a tagged section when its group is not active", () => {
    const raw = [
      "Before",
      "<!-- tools:vector -->",
      "Vector content",
      "<!-- /tools:vector -->",
      "After",
    ].join("\n");

    const result = stripInactiveSections(raw, ["kubectl"]);
    expect(result).toBe("Before\nAfter");
  });

  it("keeps a tagged section when its group is active", () => {
    const raw = [
      "Before",
      "<!-- tools:vector -->",
      "Vector content",
      "<!-- /tools:vector -->",
      "After",
    ].join("\n");

    const result = stripInactiveSections(raw, ["kubectl", "vector"]);
    expect(result).toBe("Before\nVector content\nAfter");
  });

  it("removes HTML comment tags from kept sections", () => {
    const raw = [
      "<!-- tools:vector -->",
      "Vector content",
      "<!-- /tools:vector -->",
    ].join("\n");

    const result = stripInactiveSections(raw, ["vector"]);
    expect(result).not.toContain("<!-- tools:vector -->");
    expect(result).not.toContain("<!-- /tools:vector -->");
    expect(result).toContain("Vector content");
  });

  it("removes multiple tagged sections independently", () => {
    const raw = [
      "<!-- tools:vector -->",
      "Vector",
      "<!-- /tools:vector -->",
      "Kubectl",
      "<!-- tools:apply -->",
      "Apply",
      "<!-- /tools:apply -->",
    ].join("\n");

    const result = stripInactiveSections(raw, ["kubectl"]);
    expect(result).toBe("Kubectl");
    expect(result).not.toContain("Vector");
    expect(result).not.toContain("Apply");
  });

  it("keeps multiple sections when all groups are active", () => {
    const raw = [
      "<!-- tools:vector -->",
      "Vector",
      "<!-- /tools:vector -->",
      "Kubectl",
      "<!-- tools:apply -->",
      "Apply",
      "<!-- /tools:apply -->",
    ].join("\n");

    const result = stripInactiveSections(raw, ["kubectl", "vector", "apply"]);
    expect(result).toContain("Vector");
    expect(result).toContain("Kubectl");
    expect(result).toContain("Apply");
  });

  it("cleans up multiple blank lines left by removed sections", () => {
    const raw = [
      "Line 1",
      "",
      "<!-- tools:vector -->",
      "Vector",
      "<!-- /tools:vector -->",
      "",
      "Line 2",
    ].join("\n");

    const result = stripInactiveSections(raw, ["kubectl"]);
    expect(result).not.toMatch(/\n{3,}/);
    expect(result).toContain("Line 1");
    expect(result).toContain("Line 2");
  });

  it("handles multi-line tagged sections", () => {
    const raw = [
      "Header",
      "<!-- tools:apply -->",
      "Line one",
      "Line two",
      "Line three",
      "<!-- /tools:apply -->",
      "Footer",
    ].join("\n");

    const result = stripInactiveSections(raw, ["kubectl"]);
    expect(result).toBe("Header\nFooter");
  });

  it("leaves untagged content untouched regardless of tool groups", () => {
    const raw = "Just plain kubectl content with no tags";
    expect(stripInactiveSections(raw, ["kubectl"])).toBe(raw);
    expect(stripInactiveSections(raw, ["vector"])).toBe(raw);
  });

  it("handles empty tool group list by removing all tagged sections", () => {
    const raw = [
      "Untagged",
      "<!-- tools:vector -->",
      "Vector",
      "<!-- /tools:vector -->",
    ].join("\n");

    // Empty toolGroups removes all tagged sections
    const result = stripInactiveSections(raw, []);
    expect(result).toBe("Untagged");
    expect(result).not.toContain("Vector");
  });
});
