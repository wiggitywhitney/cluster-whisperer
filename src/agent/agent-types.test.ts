// ABOUTME: Unit tests for agent type parsing and validation
// ABOUTME: Verifies --agent flag parsing, defaults, and error handling

/**
 * Tests for the agent-type parsing module.
 *
 * The --agent CLI flag selects which agent framework to use (langgraph or vercel).
 * These tests verify:
 * - Valid agent types are accepted
 * - Invalid types produce helpful error messages
 * - The default is "langgraph" for backwards compatibility
 */

import { describe, it, expect } from "vitest";
import {
  parseAgentType,
  VALID_AGENT_TYPES,
  DEFAULT_AGENT_TYPE,
  type AgentType,
} from "./agent-types";

describe("parseAgentType", () => {
  it("accepts 'langgraph'", () => {
    expect(parseAgentType("langgraph")).toBe("langgraph");
  });

  it("accepts 'vercel'", () => {
    expect(parseAgentType("vercel")).toBe("vercel");
  });

  it("trims whitespace", () => {
    expect(parseAgentType("  langgraph  ")).toBe("langgraph");
  });

  it("throws on invalid agent type", () => {
    expect(() => parseAgentType("openai")).toThrow(
      /Unknown agent type: "openai"/
    );
  });

  it("throws on empty string", () => {
    expect(() => parseAgentType("")).toThrow(/Must specify an agent type/i);
  });

  it("throws on whitespace-only string", () => {
    expect(() => parseAgentType("   ")).toThrow(/Must specify an agent type/i);
  });
});

describe("VALID_AGENT_TYPES", () => {
  it("contains langgraph and vercel", () => {
    expect(VALID_AGENT_TYPES).toEqual(["langgraph", "vercel"]);
  });
});

describe("DEFAULT_AGENT_TYPE", () => {
  it("defaults to langgraph for backwards compatibility", () => {
    expect(DEFAULT_AGENT_TYPE).toBe("langgraph");
  });
});
