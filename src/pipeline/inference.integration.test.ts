/**
 * inference.integration.test.ts - Integration tests for LLM capability inference (M2)
 *
 * Tests the inference pipeline against the real Anthropic API with fixture
 * schemas. These tests verify that the prompt template + Zod structured output
 * produces valid, reasonable results from the actual LLM.
 *
 * Requires:
 * - ANTHROPIC_API_KEY environment variable set
 * - Network access to the Anthropic API
 *
 * These tests are slower (~5-10 seconds each) and cost real API credits.
 * They run as part of the full test suite but can be skipped in CI if needed.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { inferCapability, inferCapabilities } from "./inference";
import type { DiscoveredResource, ResourceCapability } from "./types";

// ---------------------------------------------------------------------------
// Skip check
// ---------------------------------------------------------------------------

/**
 * Check if the Anthropic API key is available.
 * Integration tests require a real API key to call Claude.
 */
function shouldSkip(): string | false {
  if (!process.env.ANTHROPIC_API_KEY) {
    return "ANTHROPIC_API_KEY not set";
  }
  return false;
}

const skipReason = shouldSkip();

// ---------------------------------------------------------------------------
// Fixture schemas (captured from real kubectl explain output)
// ---------------------------------------------------------------------------

/**
 * Simplified schema for a Crossplane SQL composite resource.
 * This represents the kind of CRD the demo cluster has installed.
 */
const SQL_SCHEMA = `KIND:     SQL
VERSION:  devopstoolkit.live/v1beta1

DESCRIPTION:
  SQL is a composite resource that provisions a managed SQL database.
  It abstracts away cloud-provider details, letting developers request
  a database by specifying engine, version, and size.

FIELDS:
  apiVersion	<string>
  kind	<string>
  metadata	<ObjectMeta>
    name	<string>
    namespace	<string>
    labels	<map[string]string>
    annotations	<map[string]string>
  spec	<Object>
    compositionRef	<Object>
      name	<string>
    compositionSelector	<Object>
      matchLabels	<map[string]string>
    id	<string>
      The unique identifier for the database instance
    parameters	<Object>
      engine	<string>
        The database engine (postgresql, mysql, mariadb)
      version	<string>
        The engine version
      size	<string>
        The instance size (small, medium, large)
      region	<string>
        The cloud region to deploy in
    writeConnectionSecretToRef	<Object>
      name	<string>
      namespace	<string>
  status	<Object>
    conditions	<[]Object>
      type	<string>
      status	<string>
`;

/**
 * Simplified schema for a core ConfigMap.
 * Tests that the pipeline handles non-CRD built-in resources correctly.
 */
const CONFIGMAP_SCHEMA = `KIND:     ConfigMap
VERSION:  v1

DESCRIPTION:
  ConfigMap holds configuration data for pods to consume.

FIELDS:
  apiVersion	<string>
  kind	<string>
  metadata	<ObjectMeta>
    name	<string>
    namespace	<string>
  data	<map[string]string>
    Data contains the configuration data.
  binaryData	<map[string][]byte>
    BinaryData contains the binary data.
  immutable	<boolean>
    Immutable, if set to true, ensures that data stored in the ConfigMap cannot be updated.
`;

// ---------------------------------------------------------------------------
// Integration tests
// ---------------------------------------------------------------------------

describe.skipIf(!!skipReason)("inferCapability (integration)", () => {
  if (skipReason) {
    it.skip(`skipped: ${skipReason}`, () => {});
    return;
  }

  let sqlResult: ResourceCapability;
  let configmapResult: ResourceCapability;

  beforeAll(async () => {
    const sqlResource: DiscoveredResource = {
      name: "sqls.devopstoolkit.live",
      apiVersion: "devopstoolkit.live/v1beta1",
      group: "devopstoolkit.live",
      kind: "SQL",
      namespaced: true,
      isCRD: true,
      schema: SQL_SCHEMA,
    };

    const configmapResource: DiscoveredResource = {
      name: "configmaps",
      apiVersion: "v1",
      group: "",
      kind: "ConfigMap",
      namespaced: true,
      isCRD: false,
      schema: CONFIGMAP_SCHEMA,
    };

    // Run both inferences in beforeAll to minimize API calls
    sqlResult = await inferCapability(sqlResource);
    configmapResult = await inferCapability(configmapResource);
  }, 60_000);

  it("passes through resource metadata unchanged for SQL CRD", () => {
    expect(sqlResult.resourceName).toBe("sqls.devopstoolkit.live");
    expect(sqlResult.apiVersion).toBe("devopstoolkit.live/v1beta1");
    expect(sqlResult.group).toBe("devopstoolkit.live");
    expect(sqlResult.kind).toBe("SQL");
  });

  it("identifies database-related capabilities for SQL CRD", () => {
    expect(sqlResult.capabilities.length).toBeGreaterThan(0);
    const capText = sqlResult.capabilities.join(" ").toLowerCase();
    expect(capText).toMatch(/database|sql|postgresql/);
  });

  it("assesses reasonable complexity for SQL CRD", () => {
    expect(["low", "medium"]).toContain(sqlResult.complexity);
  });

  it("produces non-empty description and useCase for SQL CRD", () => {
    expect(sqlResult.description.length).toBeGreaterThan(10);
    expect(sqlResult.useCase.length).toBeGreaterThan(10);
  });

  it("has high confidence for well-documented SQL schema", () => {
    expect(sqlResult.confidence).toBeGreaterThanOrEqual(0.7);
    expect(sqlResult.confidence).toBeLessThanOrEqual(1.0);
  });

  it("identifies configuration-related capabilities for ConfigMap", () => {
    const capText = configmapResult.capabilities.join(" ").toLowerCase();
    expect(capText).toMatch(/config/);
  });

  it("returns empty providers for core ConfigMap resource", () => {
    expect(configmapResult.providers).toEqual([]);
  });

  it("assesses low complexity for ConfigMap", () => {
    expect(configmapResult.complexity).toBe("low");
  });
});

describe.skipIf(!!skipReason)("inferCapabilities (integration)", () => {
  if (skipReason) {
    it.skip(`skipped: ${skipReason}`, () => {});
    return;
  }

  it("processes multiple resources and reports progress", async () => {
    const resources: DiscoveredResource[] = [
      {
        name: "sqls.devopstoolkit.live",
        apiVersion: "devopstoolkit.live/v1beta1",
        group: "devopstoolkit.live",
        kind: "SQL",
        namespaced: true,
        isCRD: true,
        schema: SQL_SCHEMA,
      },
      {
        name: "configmaps",
        apiVersion: "v1",
        group: "",
        kind: "ConfigMap",
        namespaced: true,
        isCRD: false,
        schema: CONFIGMAP_SCHEMA,
      },
    ];

    const progressMessages: string[] = [];
    const results = await inferCapabilities(resources, {
      onProgress: (msg) => progressMessages.push(msg),
    });

    // Should return results for both resources
    expect(results).toHaveLength(2);
    expect(results[0].kind).toBe("SQL");
    expect(results[1].kind).toBe("ConfigMap");

    // Should have reported progress
    expect(progressMessages.length).toBeGreaterThan(0);
    expect(progressMessages.some((m) => m.includes("1 of 2"))).toBe(true);
    expect(progressMessages.some((m) => m.includes("complete"))).toBe(true);
  }, 60_000);
});
