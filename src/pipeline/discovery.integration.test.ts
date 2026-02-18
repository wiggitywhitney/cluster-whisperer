/**
 * discovery.integration.test.ts - Integration tests for CRD discovery against a live cluster
 *
 * These tests run the real discovery pipeline against whatever cluster
 * is configured in the current kubeconfig context. They verify that:
 * - Real kubectl output parses correctly
 * - Real kubectl explain schemas are extracted
 * - The pipeline handles real-world resource types
 *
 * Skip these tests with a .skip-integration file in the project root,
 * or if no cluster is available (auto-detected).
 */

import { describe, it, expect, beforeAll } from "vitest";
import { existsSync } from "fs";
import { join } from "path";
import { spawnSync } from "child_process";
import { discoverResources } from "./discovery";
import { executeKubectl } from "../utils/kubectl";

/**
 * Check if integration tests should run.
 * Skips if .skip-integration exists or no cluster is reachable.
 */
function shouldSkip(): string | false {
  if (existsSync(join(process.cwd(), ".skip-integration"))) {
    return ".skip-integration file present";
  }

  const result = spawnSync("kubectl", ["cluster-info"], {
    encoding: "utf-8",
    timeout: 5000,
  });

  if (result.status !== 0) {
    return "no Kubernetes cluster available";
  }

  return false;
}

const skipReason = shouldSkip();

describe.skipIf(!!skipReason)("discovery (integration)", () => {
  if (skipReason) {
    it.skip(`skipped: ${skipReason}`, () => {});
    return;
  }

  let resources: Awaited<ReturnType<typeof discoverResources>>;
  const progressMessages: string[] = [];

  beforeAll(async () => {
    resources = await discoverResources({
      kubectl: executeKubectl,
      onProgress: (msg) => progressMessages.push(msg),
    });
  }, 120_000); // Allow up to 2 minutes for schema extraction

  it("discovers at least some resources from the cluster", () => {
    expect(resources.length).toBeGreaterThan(0);
  });

  it("includes core Kubernetes resources", () => {
    const kinds = resources.map((r) => r.kind);
    // Every cluster has these
    expect(kinds).toContain("ConfigMap");
    expect(kinds).toContain("Pod");
    expect(kinds).toContain("Service");
  });

  it("does not include filtered-out resources", () => {
    const names = resources.map((r) => r.name);
    expect(names).not.toContain("events");
    expect(names).not.toContain("events.events.k8s.io");
    expect(names).not.toContain("leases.coordination.k8s.io");
    expect(names).not.toContain("endpointslices.discovery.k8s.io");
    expect(names).not.toContain("componentstatuses");

    // No subresources
    for (const name of names) {
      expect(name).not.toContain("/");
    }
  });

  it("extracts non-empty schemas for every resource", () => {
    for (const resource of resources) {
      expect(resource.schema.length).toBeGreaterThan(0);
    }
  });

  it("populates group and apiVersion for every resource", () => {
    for (const resource of resources) {
      expect(resource.apiVersion).toBeTruthy();
      // Group can be empty for core resources, but must be a string
      expect(typeof resource.group).toBe("string");
    }
  });

  it("logged progress messages during discovery", () => {
    expect(progressMessages.length).toBeGreaterThan(0);
    expect(progressMessages.some((m) => m.includes("Discovering"))).toBe(true);
    expect(progressMessages.some((m) => m.includes("Extracting schema"))).toBe(
      true
    );
    expect(progressMessages.some((m) => m.includes("Discovery complete"))).toBe(
      true
    );
  });
});
