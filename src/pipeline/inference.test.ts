/**
 * inference.test.ts - Unit tests for LLM capability inference (M2)
 *
 * Tests the inference pipeline that sends CRD schemas to an LLM and parses
 * structured capability descriptions. Mocks the LLM model at the system
 * boundary so tests run fast, offline, and deterministically.
 */

import { describe, it, expect, vi } from "vitest";
import { inferCapability, inferCapabilities } from "./inference";
import type {
  DiscoveredResource,
  LlmCapabilityResult,
  ResourceCapability,
} from "./types";

// ---------------------------------------------------------------------------
// Test fixture helpers
// ---------------------------------------------------------------------------

/**
 * Creates a DiscoveredResource with sensible defaults.
 * Override only the fields relevant to each test case.
 */
function makeResource(
  overrides: Partial<DiscoveredResource> = {}
): DiscoveredResource {
  return {
    name: "sqls.devopstoolkit.live",
    apiVersion: "devopstoolkit.live/v1beta1",
    group: "devopstoolkit.live",
    kind: "SQL",
    namespaced: true,
    isCRD: true,
    schema:
      "KIND:     SQL\nVERSION:  devopstoolkit.live/v1beta1\n\nDESCRIPTION:\n  SQL is a managed database.\n\nFIELDS:\n  spec.engine\t<string>\n  spec.size\t<string>\n",
    ...overrides,
  };
}

/**
 * Creates a mock LLM capability result with sensible defaults.
 * Override only the fields relevant to each test case.
 */
function makeLlmResult(
  overrides: Partial<LlmCapabilityResult> = {}
): LlmCapabilityResult {
  return {
    capabilities: ["database", "postgresql", "mysql"],
    providers: ["aws", "gcp", "azure"],
    complexity: "low",
    description:
      "Managed database solution supporting multiple SQL engine types.",
    useCase:
      "Deploy a managed SQL database without dealing with infrastructure complexity.",
    confidence: 0.9,
    ...overrides,
  };
}

/**
 * Creates a mock model that returns a canned LlmCapabilityResult.
 * The model.invoke() signature matches withStructuredOutput() output.
 */
function createMockModel(result?: LlmCapabilityResult) {
  return {
    invoke: vi.fn().mockResolvedValue(result ?? makeLlmResult()),
  };
}

// ---------------------------------------------------------------------------
// inferCapability (single resource)
// ---------------------------------------------------------------------------

describe("inferCapability", () => {
  it("returns a ResourceCapability combining resource metadata and LLM output", async () => {
    const resource = makeResource();
    const mockModel = createMockModel();

    const result = await inferCapability(resource, { model: mockModel });

    // Resource metadata fields come from the input
    expect(result.resourceName).toBe("sqls.devopstoolkit.live");
    expect(result.apiVersion).toBe("devopstoolkit.live/v1beta1");
    expect(result.group).toBe("devopstoolkit.live");
    expect(result.kind).toBe("SQL");

    // LLM-inferred fields come from the model
    expect(result.capabilities).toEqual(["database", "postgresql", "mysql"]);
    expect(result.providers).toEqual(["aws", "gcp", "azure"]);
    expect(result.complexity).toBe("low");
    expect(result.description).toBe(
      "Managed database solution supporting multiple SQL engine types."
    );
    expect(result.useCase).toBe(
      "Deploy a managed SQL database without dealing with infrastructure complexity."
    );
    expect(result.confidence).toBe(0.9);
  });

  it("passes the resource schema to the model as a human message", async () => {
    const resource = makeResource({
      schema: "KIND: SQL\nFIELDS: spec.engine <string>",
    });
    const mockModel = createMockModel();

    await inferCapability(resource, { model: mockModel });

    // The model should receive the schema in a human message
    expect(mockModel.invoke).toHaveBeenCalledOnce();
    const messages = mockModel.invoke.mock.calls[0][0];

    // Should have a system message (prompt template) and a human message (schema)
    expect(messages).toHaveLength(2);
    expect(messages[0][0]).toBe("system");
    expect(messages[1][0]).toBe("human");
    expect(messages[1][1]).toContain("KIND: SQL");
  });

  it("includes resource name and kind in the human message for context", async () => {
    const resource = makeResource({
      name: "buckets.s3.aws.upbound.io",
      kind: "Bucket",
    });
    const mockModel = createMockModel();

    await inferCapability(resource, { model: mockModel });

    const messages = mockModel.invoke.mock.calls[0][0];
    const humanMessage = messages[1][1];
    expect(humanMessage).toContain("buckets.s3.aws.upbound.io");
    expect(humanMessage).toContain("Bucket");
  });

  it("handles core resources with empty group", async () => {
    const resource = makeResource({
      name: "configmaps",
      apiVersion: "v1",
      group: "",
      kind: "ConfigMap",
      isCRD: false,
    });
    const llmResult = makeLlmResult({
      capabilities: ["configuration", "key-value"],
      providers: [],
      complexity: "low",
    });
    const mockModel = createMockModel(llmResult);

    const result = await inferCapability(resource, { model: mockModel });

    expect(result.resourceName).toBe("configmaps");
    expect(result.group).toBe("");
    expect(result.providers).toEqual([]);
  });

  it("propagates LLM errors with resource context", async () => {
    const resource = makeResource({ name: "failing.example.com" });
    const mockModel = {
      invoke: vi.fn().mockRejectedValue(new Error("Rate limit exceeded")),
    };

    await expect(
      inferCapability(resource, { model: mockModel })
    ).rejects.toThrow("failing.example.com");
    await expect(
      inferCapability(resource, { model: mockModel })
    ).rejects.toThrow("Rate limit exceeded");
  });
});

// ---------------------------------------------------------------------------
// inferCapabilities (batch)
// ---------------------------------------------------------------------------

describe("inferCapabilities", () => {
  it("processes multiple resources sequentially", async () => {
    const resources = [
      makeResource({ name: "sqls.devopstoolkit.live", kind: "SQL" }),
      makeResource({
        name: "buckets.s3.aws.upbound.io",
        kind: "Bucket",
        group: "s3.aws.upbound.io",
        apiVersion: "s3.aws.upbound.io/v1beta1",
      }),
    ];

    const callOrder: string[] = [];
    const mockModel = {
      invoke: vi.fn().mockImplementation(async (messages: Array<[string, string]>) => {
        const humanMsg = messages[1][1];
        if (humanMsg.includes("buckets.s3.aws.upbound.io")) {
          callOrder.push("bucket");
          return makeLlmResult({ capabilities: ["storage"] });
        }
        callOrder.push("sql");
        return makeLlmResult({ capabilities: ["database"] });
      }),
    };

    const results = await inferCapabilities(resources, { model: mockModel });

    expect(results).toHaveLength(2);
    expect(callOrder).toEqual(["sql", "bucket"]); // Sequential order
    expect(results[0].kind).toBe("SQL");
    expect(results[0].capabilities).toEqual(["database"]);
    expect(results[1].kind).toBe("Bucket");
    expect(results[1].capabilities).toEqual(["storage"]);
  });

  it("skips resources where LLM fails and continues pipeline", async () => {
    const resources = [
      makeResource({ name: "good.example.com", kind: "Good" }),
      makeResource({ name: "bad.example.com", kind: "Bad" }),
      makeResource({ name: "also-good.example.com", kind: "AlsoGood" }),
    ];

    let callCount = 0;
    const mockModel = {
      invoke: vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 2) {
          throw new Error("LLM timeout");
        }
        return makeLlmResult();
      }),
    };

    const results = await inferCapabilities(resources, {
      model: mockModel,
      onProgress: () => {},
    });

    // Should have 2 results (skipped the failing one)
    expect(results).toHaveLength(2);
    expect(results[0].kind).toBe("Good");
    expect(results[1].kind).toBe("AlsoGood");
  });

  it("reports progress for each resource", async () => {
    const resources = [
      makeResource({ name: "sqls.devopstoolkit.live", kind: "SQL" }),
      makeResource({ name: "buckets.s3.aws.upbound.io", kind: "Bucket" }),
    ];
    const mockModel = createMockModel();
    const progressMessages: string[] = [];

    await inferCapabilities(resources, {
      model: mockModel,
      onProgress: (msg) => progressMessages.push(msg),
    });

    // Should include count-based progress
    const inferMessages = progressMessages.filter((m) =>
      m.includes("Inferring")
    );
    expect(inferMessages.length).toBeGreaterThanOrEqual(2);
    expect(inferMessages[0]).toMatch(/1 of 2/);
    expect(inferMessages[1]).toMatch(/2 of 2/);
  });

  it("reports warnings for skipped resources", async () => {
    const resources = [
      makeResource({ name: "failing.example.com", kind: "Failing" }),
    ];
    const mockModel = {
      invoke: vi.fn().mockRejectedValue(new Error("API error")),
    };
    const progressMessages: string[] = [];

    await inferCapabilities(resources, {
      model: mockModel,
      onProgress: (msg) => progressMessages.push(msg),
    });

    const warnings = progressMessages.filter((m) => m.includes("Warning"));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("failing.example.com");
  });

  it("returns empty array for empty input", async () => {
    const mockModel = createMockModel();

    const results = await inferCapabilities([], { model: mockModel });

    expect(results).toEqual([]);
    expect(mockModel.invoke).not.toHaveBeenCalled();
  });

  it("reports completion summary", async () => {
    const resources = [
      makeResource({ name: "a.example.com" }),
      makeResource({ name: "b.example.com" }),
    ];
    const mockModel = createMockModel();
    const progressMessages: string[] = [];

    await inferCapabilities(resources, {
      model: mockModel,
      onProgress: (msg) => progressMessages.push(msg),
    });

    const lastMessage = progressMessages[progressMessages.length - 1];
    expect(lastMessage).toContain("complete");
    expect(lastMessage).toContain("2");
  });
});
