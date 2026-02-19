/**
 * instance-discovery.test.ts - Unit tests for resource instance discovery (PRD #26 M1)
 *
 * Tests the listing, parsing, and metadata extraction logic for discovering
 * running Kubernetes resource instances from a cluster. Mocks kubectl at the
 * system boundary so tests run fast, offline, and deterministically.
 */

import { describe, it, expect, vi } from "vitest";
import {
  parseInstanceList,
  filterDescriptionAnnotations,
  buildInstanceId,
  discoverInstances,
} from "./instance-discovery";
import type { ResourceInstance } from "./types";

// ---------------------------------------------------------------------------
// Test fixture helpers
// ---------------------------------------------------------------------------

/**
 * Builds a minimal Kubernetes resource object as returned by kubectl get -o json.
 * Override specific fields per test case.
 */
function makeK8sObject(overrides: {
  name?: string;
  namespace?: string;
  kind?: string;
  apiVersion?: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  creationTimestamp?: string;
} = {}): Record<string, unknown> {
  return {
    apiVersion: overrides.apiVersion ?? "apps/v1",
    kind: overrides.kind ?? "Deployment",
    metadata: {
      name: overrides.name ?? "nginx",
      namespace: overrides.namespace ?? "default",
      labels: overrides.labels ?? { app: "nginx" },
      annotations: overrides.annotations ?? {},
      creationTimestamp: overrides.creationTimestamp ?? "2026-01-15T10:30:00Z",
    },
  };
}

/**
 * Wraps K8s objects into the List format that kubectl get -o json returns.
 */
function makeK8sList(
  items: Record<string, unknown>[],
  listKind = "DeploymentList",
  apiVersion = "apps/v1"
): string {
  return JSON.stringify({
    apiVersion,
    kind: listKind,
    items,
  });
}

/**
 * Column widths for kubectl api-resources -o wide output.
 * Copied from discovery.test.ts to keep test fixtures consistent.
 */
const COL = {
  name: 25,
  shortNames: 15,
  apiVersion: 35,
  namespaced: 15,
  kind: 20,
  verbs: 62,
};

/** Builds an aligned row for kubectl api-resources -o wide output */
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

const HEADER = tableRow(
  "NAME", "SHORTNAMES", "APIVERSION", "NAMESPACED", "KIND", "VERBS", "CATEGORIES"
);

function buildApiResourcesOutput(
  rows: Array<[string, string, string, string, string, string, string?]>
): string {
  const dataRows = rows.map((r) => tableRow(...r));
  return [HEADER, ...dataRows].join("\n");
}

// ---------------------------------------------------------------------------
// parseInstanceList
// ---------------------------------------------------------------------------

describe("parseInstanceList", () => {
  it("parses a single namespaced instance", () => {
    const obj = makeK8sObject({
      name: "nginx",
      namespace: "default",
      kind: "Deployment",
      apiVersion: "apps/v1",
      labels: { app: "nginx", tier: "frontend" },
      creationTimestamp: "2026-01-15T10:30:00Z",
    });
    const json = makeK8sList([obj]);

    const result = parseInstanceList(json, "Deployment", "apps/v1", true);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      id: "default/apps/v1/Deployment/nginx",
      namespace: "default",
      name: "nginx",
      kind: "Deployment",
      apiVersion: "apps/v1",
      apiGroup: "apps",
      labels: { app: "nginx", tier: "frontend" },
      annotations: {},
      createdAt: "2026-01-15T10:30:00Z",
    });
  });

  it("parses a cluster-scoped instance with _cluster namespace", () => {
    const obj = makeK8sObject({
      name: "kube-system",
      kind: "Namespace",
      apiVersion: "v1",
    });
    // Cluster-scoped objects have no namespace field
    delete (obj as Record<string, Record<string, unknown>>).metadata.namespace;

    const json = makeK8sList([obj], "NamespaceList", "v1");

    const result = parseInstanceList(json, "Namespace", "v1", false);

    expect(result).toHaveLength(1);
    expect(result[0].namespace).toBe("_cluster");
    expect(result[0].id).toBe("_cluster/v1/Namespace/kube-system");
    expect(result[0].apiGroup).toBe("");
  });

  it("parses multiple instances", () => {
    const obj1 = makeK8sObject({ name: "nginx", namespace: "default" });
    const obj2 = makeK8sObject({ name: "redis", namespace: "cache" });
    const obj3 = makeK8sObject({ name: "api", namespace: "backend" });
    const json = makeK8sList([obj1, obj2, obj3]);

    const result = parseInstanceList(json, "Deployment", "apps/v1", true);

    expect(result).toHaveLength(3);
    expect(result.map((r) => r.name)).toEqual(["nginx", "redis", "api"]);
  });

  it("handles instances with no labels", () => {
    const obj = makeK8sObject({ labels: undefined as unknown as Record<string, string> });
    // Manually remove labels to simulate kubectl output with no labels
    (obj as Record<string, Record<string, unknown>>).metadata.labels = undefined;
    const json = makeK8sList([obj]);

    const result = parseInstanceList(json, "Deployment", "apps/v1", true);

    expect(result[0].labels).toEqual({});
  });

  it("handles instances with no annotations", () => {
    const obj = makeK8sObject();
    (obj as Record<string, Record<string, unknown>>).metadata.annotations = undefined;
    const json = makeK8sList([obj]);

    const result = parseInstanceList(json, "Deployment", "apps/v1", true);

    expect(result[0].annotations).toEqual({});
  });

  it("filters annotations to description-like only", () => {
    const obj = makeK8sObject({
      annotations: {
        "description": "Main web server",
        "app.kubernetes.io/description": "Serves frontend traffic",
        "kubectl.kubernetes.io/last-applied-configuration": '{"big":"json"}',
        "deployment.kubernetes.io/revision": "3",
        "some-operator.io/checksum": "abc123",
      },
    });
    const json = makeK8sList([obj]);

    const result = parseInstanceList(json, "Deployment", "apps/v1", true);

    expect(result[0].annotations).toEqual({
      "description": "Main web server",
      "app.kubernetes.io/description": "Serves frontend traffic",
    });
  });

  it("returns empty array for empty items list", () => {
    const json = makeK8sList([]);

    const result = parseInstanceList(json, "Deployment", "apps/v1", true);

    expect(result).toEqual([]);
  });

  it("handles CRD instances with multi-segment API groups", () => {
    const obj = makeK8sObject({
      name: "my-db",
      namespace: "databases",
      kind: "SQL",
      apiVersion: "devopstoolkit.live/v1beta1",
      labels: { "app.kubernetes.io/name": "my-db" },
    });
    const json = makeK8sList([obj], "SQLList", "devopstoolkit.live/v1beta1");

    const result = parseInstanceList(json, "SQL", "devopstoolkit.live/v1beta1", true);

    expect(result).toHaveLength(1);
    expect(result[0].apiGroup).toBe("devopstoolkit.live");
    expect(result[0].id).toBe("databases/devopstoolkit.live/v1beta1/SQL/my-db");
  });
});

// ---------------------------------------------------------------------------
// filterDescriptionAnnotations
// ---------------------------------------------------------------------------

describe("filterDescriptionAnnotations", () => {
  it("keeps 'description' annotation", () => {
    const result = filterDescriptionAnnotations({
      description: "A web server",
    });
    expect(result).toEqual({ description: "A web server" });
  });

  it("keeps annotations ending with /description", () => {
    const result = filterDescriptionAnnotations({
      "app.kubernetes.io/description": "Frontend app",
      "custom.io/description": "Custom desc",
    });
    expect(result).toEqual({
      "app.kubernetes.io/description": "Frontend app",
      "custom.io/description": "Custom desc",
    });
  });

  it("filters out non-description annotations", () => {
    const result = filterDescriptionAnnotations({
      "kubectl.kubernetes.io/last-applied-configuration": '{"big":"json"}',
      "deployment.kubernetes.io/revision": "3",
      "some-operator.io/checksum": "abc123",
      "meta.helm.sh/release-name": "my-release",
    });
    expect(result).toEqual({});
  });

  it("returns empty object for undefined input", () => {
    const result = filterDescriptionAnnotations(undefined);
    expect(result).toEqual({});
  });

  it("returns empty object for empty annotations", () => {
    const result = filterDescriptionAnnotations({});
    expect(result).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// buildInstanceId
// ---------------------------------------------------------------------------

describe("buildInstanceId", () => {
  it("builds ID for namespaced resource", () => {
    expect(buildInstanceId("default", "apps/v1", "Deployment", "nginx"))
      .toBe("default/apps/v1/Deployment/nginx");
  });

  it("builds ID for cluster-scoped resource", () => {
    expect(buildInstanceId("_cluster", "v1", "Namespace", "kube-system"))
      .toBe("_cluster/v1/Namespace/kube-system");
  });

  it("builds ID for CRD instance", () => {
    expect(buildInstanceId("databases", "devopstoolkit.live/v1beta1", "SQL", "my-db"))
      .toBe("databases/devopstoolkit.live/v1beta1/SQL/my-db");
  });
});

// ---------------------------------------------------------------------------
// discoverInstances (full orchestration with mocked kubectl)
// ---------------------------------------------------------------------------

describe("discoverInstances", () => {
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
      "namespaces",
      "ns",
      "v1",
      "false",
      "Namespace",
      "create,delete,get,list,patch,update,watch",
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

  /** Fixture: kubectl get configmaps -A -o json */
  const configmapInstances = makeK8sList(
    [
      makeK8sObject({
        name: "kube-root-ca.crt",
        namespace: "default",
        kind: "ConfigMap",
        apiVersion: "v1",
        labels: {},
      }),
    ],
    "ConfigMapList",
    "v1"
  );

  /** Fixture: kubectl get namespaces -o json (cluster-scoped, no -A) */
  const namespaceInstances = makeK8sList(
    [
      makeK8sObject({
        name: "default",
        kind: "Namespace",
        apiVersion: "v1",
        labels: { "kubernetes.io/metadata.name": "default" },
      }),
      makeK8sObject({
        name: "kube-system",
        kind: "Namespace",
        apiVersion: "v1",
        labels: { "kubernetes.io/metadata.name": "kube-system" },
      }),
    ],
    "NamespaceList",
    "v1"
  );

  /** Fixture: kubectl get pods -A -o json */
  const podInstances = makeK8sList(
    [
      makeK8sObject({
        name: "nginx-abc123",
        namespace: "default",
        kind: "Pod",
        apiVersion: "v1",
        labels: { app: "nginx" },
      }),
    ],
    "PodList",
    "v1"
  );

  /** Fixture: kubectl get deployments -A -o json */
  const deploymentInstances = makeK8sList(
    [
      makeK8sObject({
        name: "nginx",
        namespace: "default",
        kind: "Deployment",
        apiVersion: "apps/v1",
        labels: { app: "nginx" },
      }),
    ],
    "DeploymentList",
    "apps/v1"
  );

  /** Fixture: kubectl get sqls -A -o json */
  const sqlInstances = makeK8sList(
    [
      makeK8sObject({
        name: "my-db",
        namespace: "databases",
        kind: "SQL",
        apiVersion: "devopstoolkit.live/v1beta1",
        labels: { "app.kubernetes.io/name": "my-db" },
      }),
    ],
    "SQLList",
    "devopstoolkit.live/v1beta1"
  );

  /**
   * Creates a mock kubectl executor that returns canned responses
   * based on the kubectl subcommand.
   */
  function createMockKubectl() {
    return vi.fn((args: string[]) => {
      if (args[0] === "api-resources") {
        return { output: apiResourcesOutput, isError: false };
      }
      if (args[0] === "get") {
        const resource = args[1];
        // Determine if this is a namespaced or cluster-scoped query
        // Namespaced queries use -A flag, cluster-scoped don't
        if (resource === "configmaps") {
          return { output: configmapInstances, isError: false };
        }
        if (resource === "namespaces") {
          return { output: namespaceInstances, isError: false };
        }
        if (resource === "pods") {
          return { output: podInstances, isError: false };
        }
        if (resource === "deployments") {
          return { output: deploymentInstances, isError: false };
        }
        if (resource === "sqls") {
          return { output: sqlInstances, isError: false };
        }
      }
      return { output: "unknown command", isError: true };
    });
  }

  it("discovers instances across multiple resource types", async () => {
    const mockKubectl = createMockKubectl();

    const result = await discoverInstances({
      kubectl: mockKubectl,
      onProgress: () => {},
    });

    // Should find: 1 configmap + 2 namespaces + 1 pod + 1 deployment + 1 sql = 6
    // events and pods/log are filtered out
    expect(result).toHaveLength(6);

    const names = result.map((r) => r.name);
    expect(names).toContain("kube-root-ca.crt");
    expect(names).toContain("default");
    expect(names).toContain("kube-system");
    expect(names).toContain("nginx-abc123");
    expect(names).toContain("nginx");
    expect(names).toContain("my-db");
  });

  it("filters out excluded resource types (events, subresources)", async () => {
    const mockKubectl = createMockKubectl();

    const result = await discoverInstances({
      kubectl: mockKubectl,
      onProgress: () => {},
    });

    // events should be excluded
    const kinds = result.map((r) => r.kind);
    expect(kinds).not.toContain("Event");

    // kubectl get should NOT have been called for events
    const getCalls = mockKubectl.mock.calls.filter(
      (call) => call[0][0] === "get" && call[0][1] === "events"
    );
    expect(getCalls).toHaveLength(0);
  });

  it("uses -A flag for namespaced resources and omits it for cluster-scoped", async () => {
    const mockKubectl = createMockKubectl();

    await discoverInstances({
      kubectl: mockKubectl,
      onProgress: () => {},
    });

    // Check that namespaced resources use -A
    const deploymentCall = mockKubectl.mock.calls.find(
      (call) => call[0][0] === "get" && call[0][1] === "deployments"
    );
    expect(deploymentCall).toBeDefined();
    expect(deploymentCall![0]).toContain("-A");

    // Check that cluster-scoped resources don't use -A
    const namespaceCall = mockKubectl.mock.calls.find(
      (call) => call[0][0] === "get" && call[0][1] === "namespaces"
    );
    expect(namespaceCall).toBeDefined();
    expect(namespaceCall![0]).not.toContain("-A");
  });

  it("handles kubectl get failure for a resource type gracefully", async () => {
    const mockKubectl = vi.fn((args: string[]) => {
      if (args[0] === "api-resources") {
        return { output: apiResourcesOutput, isError: false };
      }
      if (args[0] === "get" && args[1] === "deployments") {
        return { output: "Error: forbidden", isError: true };
      }
      if (args[0] === "get") {
        const resource = args[1];
        if (resource === "configmaps") return { output: configmapInstances, isError: false };
        if (resource === "namespaces") return { output: namespaceInstances, isError: false };
        if (resource === "pods") return { output: podInstances, isError: false };
        if (resource === "sqls") return { output: sqlInstances, isError: false };
      }
      return { output: "unknown", isError: true };
    });

    const result = await discoverInstances({
      kubectl: mockKubectl,
      onProgress: () => {},
    });

    // Should still get instances from the non-failing types
    // 1 configmap + 2 namespaces + 1 pod + 1 sql = 5 (no deployments)
    expect(result).toHaveLength(5);
    expect(result.map((r) => r.kind)).not.toContain("Deployment");
  });

  it("throws on kubectl api-resources failure", async () => {
    const mockKubectl = vi.fn(() => ({
      output: "Error: connection refused",
      isError: true,
    }));

    await expect(
      discoverInstances({ kubectl: mockKubectl, onProgress: () => {} })
    ).rejects.toThrow("Failed to list API resources");
  });

  it("supports filtering to specific resource types", async () => {
    const mockKubectl = createMockKubectl();

    const result = await discoverInstances({
      kubectl: mockKubectl,
      onProgress: () => {},
      resourceTypes: ["deployments", "sqls"],
    });

    // Should only discover instances of deployments and sqls
    expect(result).toHaveLength(2);
    const kinds = new Set(result.map((r) => r.kind));
    expect(kinds).toEqual(new Set(["Deployment", "SQL"]));
  });

  it("reports progress during instance listing", async () => {
    const mockKubectl = createMockKubectl();
    const progressMessages: string[] = [];

    await discoverInstances({
      kubectl: mockKubectl,
      onProgress: (msg) => progressMessages.push(msg),
    });

    expect(progressMessages.length).toBeGreaterThan(0);

    // Should include instance listing progress with counts
    const listingMessages = progressMessages.filter((m) =>
      m.includes("Listing instances")
    );
    expect(listingMessages.length).toBeGreaterThan(0);
    expect(listingMessages[0]).toMatch(/\(\d+ of \d+\)/);
  });

  it("reports total instance count at completion", async () => {
    const mockKubectl = createMockKubectl();
    const progressMessages: string[] = [];

    await discoverInstances({
      kubectl: mockKubectl,
      onProgress: (msg) => progressMessages.push(msg),
    });

    const completionMessage = progressMessages[progressMessages.length - 1];
    expect(completionMessage).toMatch(/Discovery complete: \d+ instances/);
  });

  it("requires list verb for resource types", async () => {
    // Create api-resources output with a resource that has get but not list
    const apiOutput = buildApiResourcesOutput([
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
        "bindings",
        "",
        "v1",
        "true",
        "Binding",
        "create",
      ],
    ]);

    const mockKubectl = vi.fn((args: string[]) => {
      if (args[0] === "api-resources") {
        return { output: apiOutput, isError: false };
      }
      if (args[0] === "get" && args[1] === "deployments") {
        return { output: deploymentInstances, isError: false };
      }
      return { output: "unknown", isError: true };
    });

    const result = await discoverInstances({
      kubectl: mockKubectl,
      onProgress: () => {},
    });

    // bindings has no list verb, so should only get deployments
    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe("Deployment");
  });
});
