/**
 * discovery.test.ts - Unit tests for CRD discovery (M1)
 *
 * Tests the parsing, filtering, and orchestration logic for discovering
 * Kubernetes resource types from a cluster. Mocks kubectl at the system
 * boundary so tests run fast, offline, and deterministically.
 */

import { describe, it, expect, vi } from "vitest";
import {
  parseApiResources,
  extractGroup,
  buildFullyQualifiedName,
  filterResources,
  discoverResources,
} from "./discovery";
import type { ParsedApiResource } from "./types";

// ---------------------------------------------------------------------------
// Test fixture helpers
// ---------------------------------------------------------------------------

/**
 * Column widths for kubectl api-resources -o wide output.
 * Each value is the total width allocated to that column (value + padding).
 * The last column (CATEGORIES) has no fixed width.
 */
const COL = {
  name: 25,
  shortNames: 15,
  apiVersion: 35,
  namespaced: 15,
  kind: 20,
  verbs: 62,
};

/**
 * Builds a properly aligned row for kubectl api-resources -o wide output.
 * Guarantees column positions match the header exactly, which is how kubectl
 * formats its table output (fixed-width columns based on the widest value).
 */
function tableRow(
  name: string,
  shortNames: string,
  apiVersion: string,
  namespaced: string,
  kind: string,
  verbs: string,
  categories: string = ""
): string {
  return (
    name.padEnd(COL.name) +
    shortNames.padEnd(COL.shortNames) +
    apiVersion.padEnd(COL.apiVersion) +
    namespaced.padEnd(COL.namespaced) +
    kind.padEnd(COL.kind) +
    verbs.padEnd(COL.verbs) +
    categories
  );
}

/** Header row for kubectl api-resources -o wide */
const HEADER = tableRow(
  "NAME",
  "SHORTNAMES",
  "APIVERSION",
  "NAMESPACED",
  "KIND",
  "VERBS",
  "CATEGORIES"
);

/**
 * Builds a complete kubectl api-resources -o wide output string.
 * Takes an array of row tuples and prepends the header.
 */
function buildApiResourcesOutput(
  rows: Array<
    [
      name: string,
      shortNames: string,
      apiVersion: string,
      namespaced: string,
      kind: string,
      verbs: string,
      categories?: string,
    ]
  >
): string {
  const dataRows = rows.map((r) => tableRow(...r));
  return [HEADER, ...dataRows].join("\n");
}

// ---------------------------------------------------------------------------
// parseApiResources
// ---------------------------------------------------------------------------

describe("parseApiResources", () => {
  it("parses a standard resource with all fields", () => {
    const output = buildApiResourcesOutput([
      [
        "deployments",
        "deploy",
        "apps/v1",
        "true",
        "Deployment",
        "create,delete,deletecollection,get,list,patch,update,watch",
        "all",
      ],
    ]);

    const result = parseApiResources(output);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      name: "deployments",
      shortNames: "deploy",
      apiVersion: "apps/v1",
      namespaced: true,
      kind: "Deployment",
      verbs: [
        "create",
        "delete",
        "deletecollection",
        "get",
        "list",
        "patch",
        "update",
        "watch",
      ],
      categories: ["all"],
    });
  });

  it("handles resources with empty shortnames", () => {
    const output = buildApiResourcesOutput([
      [
        "configmaps",
        "",
        "v1",
        "true",
        "ConfigMap",
        "create,delete,deletecollection,get,list,patch,update,watch",
      ],
    ]);

    const result = parseApiResources(output);

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("configmaps");
    expect(result[0].shortNames).toBe("");
    expect(result[0].apiVersion).toBe("v1");
  });

  it("handles resources with empty categories", () => {
    const output = buildApiResourcesOutput([
      [
        "leases",
        "",
        "coordination.k8s.io/v1",
        "true",
        "Lease",
        "create,delete,deletecollection,get,list,patch,update,watch",
      ],
    ]);

    const result = parseApiResources(output);

    expect(result).toHaveLength(1);
    expect(result[0].categories).toEqual([]);
  });

  it("handles CRD resources with custom API groups", () => {
    const output = buildApiResourcesOutput([
      [
        "sqls",
        "",
        "devopstoolkit.live/v1beta1",
        "true",
        "SQL",
        "delete,deletecollection,get,list,patch,create,update,watch",
      ],
    ]);

    const result = parseApiResources(output);

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("sqls");
    expect(result[0].apiVersion).toBe("devopstoolkit.live/v1beta1");
    expect(result[0].kind).toBe("SQL");
  });

  it("handles subresource entries", () => {
    const output = buildApiResourcesOutput([
      ["pods/log", "", "v1", "true", "Pod", "get"],
      ["pods/status", "", "v1", "true", "Pod", "get,patch,update"],
    ]);

    const result = parseApiResources(output);

    expect(result).toHaveLength(2);
    expect(result[0].name).toBe("pods/log");
    expect(result[1].name).toBe("pods/status");
  });

  it("parses multiple resources correctly", () => {
    const output = buildApiResourcesOutput([
      [
        "deployments",
        "deploy",
        "apps/v1",
        "true",
        "Deployment",
        "create,delete,deletecollection,get,list,patch,update,watch",
        "all",
      ],
      [
        "services",
        "svc",
        "v1",
        "true",
        "Service",
        "create,delete,deletecollection,get,list,patch,update,watch",
        "all",
      ],
      [
        "nodes",
        "",
        "v1",
        "false",
        "Node",
        "create,delete,deletecollection,get,list,patch,update,watch",
      ],
    ]);

    const result = parseApiResources(output);

    expect(result).toHaveLength(3);
    expect(result[0].kind).toBe("Deployment");
    expect(result[1].kind).toBe("Service");
    expect(result[2].namespaced).toBe(false);
  });

  it("returns empty array for header-with-no-data input", () => {
    expect(parseApiResources(HEADER)).toEqual([]);
  });

  it("returns empty array for empty input", () => {
    expect(parseApiResources("")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// extractGroup
// ---------------------------------------------------------------------------

describe("extractGroup", () => {
  it('returns empty string for core v1 resources', () => {
    expect(extractGroup("v1")).toBe("");
  });

  it('extracts group from standard groups like apps/v1', () => {
    expect(extractGroup("apps/v1")).toBe("apps");
  });

  it("extracts group from multi-segment groups", () => {
    expect(extractGroup("devopstoolkit.live/v1beta1")).toBe(
      "devopstoolkit.live"
    );
  });

  it("extracts group from k8s.io groups", () => {
    expect(extractGroup("coordination.k8s.io/v1")).toBe(
      "coordination.k8s.io"
    );
    expect(extractGroup("discovery.k8s.io/v1")).toBe("discovery.k8s.io");
  });
});

// ---------------------------------------------------------------------------
// buildFullyQualifiedName
// ---------------------------------------------------------------------------

describe("buildFullyQualifiedName", () => {
  it("returns just name for core resources with empty group", () => {
    expect(buildFullyQualifiedName("configmaps", "")).toBe("configmaps");
  });

  it("appends group for standard resources", () => {
    expect(buildFullyQualifiedName("deployments", "apps")).toBe(
      "deployments.apps"
    );
  });

  it("appends group for CRDs", () => {
    expect(
      buildFullyQualifiedName("sqls", "devopstoolkit.live")
    ).toBe("sqls.devopstoolkit.live");
  });
});

// ---------------------------------------------------------------------------
// filterResources
// ---------------------------------------------------------------------------

describe("filterResources", () => {
  /**
   * Helper to create a ParsedApiResource with sensible defaults.
   * Override the specific fields relevant to each test case.
   */
  function resource(overrides: Partial<ParsedApiResource>): ParsedApiResource {
    return {
      name: "configmaps",
      shortNames: "",
      apiVersion: "v1",
      namespaced: true,
      kind: "ConfigMap",
      verbs: [
        "create",
        "delete",
        "deletecollection",
        "get",
        "list",
        "patch",
        "update",
        "watch",
      ],
      categories: [],
      ...overrides,
    };
  }

  it('removes subresources (names containing "/")', () => {
    const resources = [
      resource({ name: "pods" }),
      resource({ name: "pods/log", kind: "Pod" }),
      resource({ name: "pods/status", kind: "Pod" }),
    ];

    const filtered = filterResources(resources);

    expect(filtered).toHaveLength(1);
    expect(filtered[0].name).toBe("pods");
  });

  it("removes core events", () => {
    const resources = [
      resource({ name: "events", kind: "Event" }),
      resource({ name: "configmaps" }),
    ];

    const filtered = filterResources(resources);

    expect(filtered).toHaveLength(1);
    expect(filtered[0].name).toBe("configmaps");
  });

  it("removes events.k8s.io events", () => {
    const resources = [
      resource({
        name: "events",
        kind: "Event",
        apiVersion: "events.k8s.io/v1",
      }),
      resource({ name: "configmaps" }),
    ];

    const filtered = filterResources(resources);

    expect(filtered).toHaveLength(1);
    expect(filtered[0].name).toBe("configmaps");
  });

  it("removes leases", () => {
    const resources = [
      resource({
        name: "leases",
        kind: "Lease",
        apiVersion: "coordination.k8s.io/v1",
      }),
      resource({ name: "configmaps" }),
    ];

    const filtered = filterResources(resources);

    expect(filtered).toHaveLength(1);
    expect(filtered[0].name).toBe("configmaps");
  });

  it("removes endpointslices", () => {
    const resources = [
      resource({
        name: "endpointslices",
        kind: "EndpointSlice",
        apiVersion: "discovery.k8s.io/v1",
      }),
      resource({ name: "configmaps" }),
    ];

    const filtered = filterResources(resources);

    expect(filtered).toHaveLength(1);
    expect(filtered[0].name).toBe("configmaps");
  });

  it("removes endpoints", () => {
    const resources = [
      resource({ name: "endpoints", kind: "Endpoints" }),
      resource({ name: "configmaps" }),
    ];

    const filtered = filterResources(resources);

    expect(filtered).toHaveLength(1);
    expect(filtered[0].name).toBe("configmaps");
  });

  it("removes componentstatuses", () => {
    const resources = [
      resource({
        name: "componentstatuses",
        kind: "ComponentStatus",
        verbs: ["get", "list"],
      }),
      resource({ name: "configmaps" }),
    ];

    const filtered = filterResources(resources);

    expect(filtered).toHaveLength(1);
    expect(filtered[0].name).toBe("configmaps");
  });

  it('removes resources without "get" verb', () => {
    const resources = [
      resource({ name: "bindings", kind: "Binding", verbs: ["create"] }),
      resource({
        name: "tokenreviews",
        kind: "TokenReview",
        apiVersion: "authentication.k8s.io/v1",
        verbs: ["create"],
      }),
      resource({ name: "configmaps" }),
    ];

    const filtered = filterResources(resources);

    expect(filtered).toHaveLength(1);
    expect(filtered[0].name).toBe("configmaps");
  });

  it("keeps standard resources with get verb", () => {
    const resources = [
      resource({ name: "deployments", kind: "Deployment", apiVersion: "apps/v1" }),
      resource({ name: "services", kind: "Service" }),
      resource({ name: "pods", kind: "Pod" }),
      resource({ name: "nodes", kind: "Node", namespaced: false }),
    ];

    const filtered = filterResources(resources);

    expect(filtered).toHaveLength(4);
  });

  it("keeps CRDs", () => {
    const resources = [
      resource({
        name: "sqls",
        kind: "SQL",
        apiVersion: "devopstoolkit.live/v1beta1",
      }),
      resource({
        name: "buckets",
        kind: "Bucket",
        apiVersion: "s3.aws.upbound.io/v1beta1",
      }),
    ];

    const filtered = filterResources(resources);

    expect(filtered).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// discoverResources (integration of all steps with mocked kubectl)
// ---------------------------------------------------------------------------

describe("discoverResources", () => {
  /** Fixture: kubectl api-resources -o wide output */
  const apiResourcesOutput = buildApiResourcesOutput([
    [
      "configmaps",
      "cm",
      "v1",
      "true",
      "ConfigMap",
      "create,delete,deletecollection,get,list,patch,update,watch",
    ],
    [
      "events",
      "ev",
      "v1",
      "true",
      "Event",
      "create,delete,deletecollection,get,list,patch,update,watch",
    ],
    [
      "pods",
      "",
      "v1",
      "true",
      "Pod",
      "create,delete,deletecollection,get,list,patch,update,watch",
      "all",
    ],
    ["pods/log", "", "v1", "true", "Pod", "get"],
    [
      "deployments",
      "deploy",
      "apps/v1",
      "true",
      "Deployment",
      "create,delete,deletecollection,get,list,patch,update,watch",
      "all",
    ],
    [
      "sqls",
      "",
      "devopstoolkit.live/v1beta1",
      "true",
      "SQL",
      "delete,deletecollection,get,list,patch,create,update,watch",
    ],
  ]);

  /** Fixture: kubectl get crd -o json output */
  const crdListOutput = JSON.stringify({
    apiVersion: "apiextensions.k8s.io/v1",
    kind: "CustomResourceDefinitionList",
    items: [{ metadata: { name: "sqls.devopstoolkit.live" } }],
  });

  /** Fixture: kubectl explain output (simplified) */
  const explainOutput =
    "KIND:     ConfigMap\nVERSION:  v1\n\nDESCRIPTION:\n  A key-value store.\n\nFIELDS:\n  data\t<map[string]string>\n";

  /**
   * Creates a mock kubectl executor that returns canned responses
   * based on the kubectl subcommand (api-resources, get crd, explain).
   */
  function createMockKubectl() {
    return vi.fn((args: string[]) => {
      if (args[0] === "api-resources") {
        return { output: apiResourcesOutput, isError: false };
      }
      if (args[0] === "get" && args[1] === "crd") {
        return { output: crdListOutput, isError: false };
      }
      if (args[0] === "explain") {
        return { output: explainOutput, isError: false };
      }
      return { output: "unknown command", isError: true };
    });
  }

  it("discovers, filters, identifies CRDs, and extracts schemas", async () => {
    const mockKubectl = createMockKubectl();

    const result = await discoverResources({
      kubectl: mockKubectl,
      onProgress: () => {},
    });

    // Should have 4 resources: configmaps, pods, deployments, sqls
    // Filtered out: events (excluded name), pods/log (subresource)
    expect(result).toHaveLength(4);

    const names = result.map((r) => r.name);
    expect(names).toContain("configmaps");
    expect(names).toContain("pods");
    expect(names).toContain("deployments.apps");
    expect(names).toContain("sqls.devopstoolkit.live");

    // events and subresources should not be present
    expect(names).not.toContain("events");
    expect(names).not.toContain("pods/log");
  });

  it("marks CRDs correctly using kubectl get crd output", async () => {
    const mockKubectl = createMockKubectl();

    const result = await discoverResources({
      kubectl: mockKubectl,
      onProgress: () => {},
    });

    const sql = result.find((r) => r.kind === "SQL");
    expect(sql).toBeDefined();
    expect(sql!.isCRD).toBe(true);

    const deployment = result.find((r) => r.kind === "Deployment");
    expect(deployment).toBeDefined();
    expect(deployment!.isCRD).toBe(false);
  });

  it("includes schema text from kubectl explain", async () => {
    const mockKubectl = createMockKubectl();

    const result = await discoverResources({
      kubectl: mockKubectl,
      onProgress: () => {},
    });

    // Every resource should have the schema from our mock
    for (const resource of result) {
      expect(resource.schema).toBe(explainOutput);
    }
  });

  it("sets group and apiVersion correctly", async () => {
    const mockKubectl = createMockKubectl();

    const result = await discoverResources({
      kubectl: mockKubectl,
      onProgress: () => {},
    });

    const configmap = result.find((r) => r.kind === "ConfigMap");
    expect(configmap!.group).toBe("");
    expect(configmap!.apiVersion).toBe("v1");

    const deployment = result.find((r) => r.kind === "Deployment");
    expect(deployment!.group).toBe("apps");
    expect(deployment!.apiVersion).toBe("apps/v1");

    const sql = result.find((r) => r.kind === "SQL");
    expect(sql!.group).toBe("devopstoolkit.live");
    expect(sql!.apiVersion).toBe("devopstoolkit.live/v1beta1");
  });

  it("handles empty CRD list gracefully", async () => {
    const mockKubectl = vi.fn((args: string[]) => {
      if (args[0] === "api-resources") {
        return { output: apiResourcesOutput, isError: false };
      }
      if (args[0] === "get" && args[1] === "crd") {
        return {
          output: JSON.stringify({ items: [] }),
          isError: false,
        };
      }
      if (args[0] === "explain") {
        return { output: explainOutput, isError: false };
      }
      return { output: "unknown command", isError: true };
    });

    const result = await discoverResources({
      kubectl: mockKubectl,
      onProgress: () => {},
    });

    // All resources should have isCRD = false
    for (const resource of result) {
      expect(resource.isCRD).toBe(false);
    }
  });

  it("handles kubectl api-resources error", async () => {
    const mockKubectl = vi.fn((args: string[]) => {
      if (args[0] === "api-resources") {
        return {
          output: 'Error: couldn\'t get resource list',
          isError: true,
        };
      }
      return { output: "", isError: false };
    });

    await expect(
      discoverResources({ kubectl: mockKubectl, onProgress: () => {} })
    ).rejects.toThrow("Failed to list API resources");
  });

  it("skips resources where kubectl explain fails", async () => {
    let explainCallCount = 0;
    const mockKubectl = vi.fn((args: string[]) => {
      if (args[0] === "api-resources") {
        return { output: apiResourcesOutput, isError: false };
      }
      if (args[0] === "get" && args[1] === "crd") {
        return { output: crdListOutput, isError: false };
      }
      if (args[0] === "explain") {
        explainCallCount++;
        // Fail on the second explain call
        if (explainCallCount === 2) {
          return { output: "Error: resource not found", isError: true };
        }
        return { output: explainOutput, isError: false };
      }
      return { output: "unknown command", isError: true };
    });

    const result = await discoverResources({
      kubectl: mockKubectl,
      onProgress: () => {},
    });

    // Should have 3 resources (4 after filtering, minus 1 failed explain)
    expect(result).toHaveLength(3);
  });

  it("reports progress during schema extraction", async () => {
    const mockKubectl = createMockKubectl();
    const progressMessages: string[] = [];

    await discoverResources({
      kubectl: mockKubectl,
      onProgress: (msg) => progressMessages.push(msg),
    });

    // Should have progress messages for discovery steps + each resource
    expect(progressMessages.length).toBeGreaterThan(0);

    // Should include schema extraction progress with counts
    const schemaMessages = progressMessages.filter((m) =>
      m.includes("Extracting schema")
    );
    expect(schemaMessages.length).toBeGreaterThan(0);
    // Should include a count like "(1 of 4)"
    expect(schemaMessages[0]).toMatch(/\(\d+ of \d+\)/);
  });
});
