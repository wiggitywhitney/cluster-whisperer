/**
 * discovery.ts - CRD and API resource discovery for the capability inference pipeline (M1)
 *
 * Discovers all resource types in a Kubernetes cluster, filters out low-value ones,
 * and extracts their schemas for LLM analysis.
 *
 * Three-step flow:
 * 1. Discover — kubectl api-resources + kubectl get crd to find all resource types
 * 2. Filter — Remove subresources, high-churn resources, and resources without get verb
 * 3. Extract — kubectl explain --recursive for each remaining resource's schema
 *
 * The output (DiscoveredResource[]) feeds directly into M2's LLM inference pipeline.
 */

import { executeKubectl as defaultKubectl } from "../utils/kubectl";
import type {
  ParsedApiResource,
  DiscoveredResource,
  DiscoveryOptions,
} from "./types";

/**
 * Resource names to exclude from discovery.
 *
 * These are internal Kubernetes plumbing that don't represent capabilities
 * a developer would search for. Filtering them saves LLM calls and keeps
 * search results clean.
 *
 * - events: High-churn diagnostic records, not a deployable resource
 * - componentstatuses: Deprecated since Kubernetes 1.19
 * - endpoints: Internal service discovery plumbing (use Services instead)
 * - leases: Leader-election bookkeeping for controllers
 * - endpointslices: Internal service mesh routing data
 */
const EXCLUDED_RESOURCE_NAMES = new Set([
  "events",
  "componentstatuses",
  "endpoints",
  "leases",
  "endpointslices",
]);

// ---------------------------------------------------------------------------
// Pure functions (exported for unit testing)
// ---------------------------------------------------------------------------

/**
 * Parses the output of `kubectl api-resources -o wide` into structured data.
 *
 * kubectl formats its output as a fixed-width table where column positions
 * are determined by the header line. This parser finds each column's start
 * position from the header, then extracts values from each data row at
 * those positions.
 *
 * @param output - Raw stdout from kubectl api-resources -o wide
 * @returns Parsed resource metadata for each row
 */
export function parseApiResources(output: string): ParsedApiResource[] {
  const lines = output.trim().split("\n");
  if (lines.length < 2) return [];

  const header = lines[0];

  // Find where each column starts in the header line.
  // kubectl always outputs these columns in this exact order for -o wide.
  const columnNames = [
    "NAME",
    "SHORTNAMES",
    "APIVERSION",
    "NAMESPACED",
    "KIND",
    "VERBS",
    "CATEGORIES",
  ] as const;

  const positions = columnNames.map((name) => {
    const pos = header.indexOf(name);
    if (pos === -1) {
      throw new Error(
        `Column "${name}" not found in api-resources header: "${header}"`
      );
    }
    return pos;
  });

  return lines
    .slice(1)
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      /**
       * Extracts a column value from a fixed-width table row.
       * Reads from this column's start position to the next column's start,
       * handling rows that are shorter than the last column position.
       */
      const getValue = (colIndex: number): string => {
        const start = positions[colIndex];
        if (start >= line.length) return "";
        const end =
          colIndex + 1 < positions.length
            ? positions[colIndex + 1]
            : line.length;
        return line.substring(start, Math.min(end, line.length)).trim();
      };

      return {
        name: getValue(0),
        shortNames: getValue(1),
        apiVersion: getValue(2),
        namespaced: getValue(3) === "true",
        kind: getValue(4),
        verbs: getValue(5)
          .split(",")
          .filter((v) => v.length > 0),
        categories: getValue(6)
          .split(",")
          .filter((c) => c.length > 0),
      };
    });
}

/**
 * Extracts the API group from a full API version string.
 *
 * Kubernetes API versions have two formats:
 * - Core resources: "v1" (no group, just a version)
 * - Grouped resources: "apps/v1", "devopstoolkit.live/v1beta1" (group/version)
 *
 * @param apiVersion - Full API version (e.g., "apps/v1", "v1")
 * @returns The group portion, or empty string for core resources
 */
export function extractGroup(apiVersion: string): string {
  const slashIndex = apiVersion.indexOf("/");
  return slashIndex === -1 ? "" : apiVersion.substring(0, slashIndex);
}

/**
 * Builds the fully qualified resource name used by kubectl explain.
 *
 * For core resources (empty group): just the plural name (e.g., "configmaps")
 * For grouped resources: name.group (e.g., "deployments.apps")
 *
 * This format matches what `kubectl get crd` returns for CRD names,
 * enabling direct comparison to identify CRDs.
 *
 * @param name - Plural resource name from api-resources
 * @param group - API group (empty string for core resources)
 */
export function buildFullyQualifiedName(
  name: string,
  group: string
): string {
  return group ? `${name}.${group}` : name;
}

/**
 * Filters out resources that aren't useful for capability inference.
 *
 * Removes:
 * - Subresources (pods/log, deployments/scale) — not standalone types
 * - High-churn system resources (events, leases) — internal plumbing
 * - Deprecated resources (componentstatuses)
 * - Resources without "get" verb — can't extract their schema
 *
 * The filter is deliberately conservative: better to keep a borderline
 * resource than accidentally skip a useful CRD.
 */
export function filterResources(
  resources: ParsedApiResource[]
): ParsedApiResource[] {
  return resources.filter((r) => {
    // Subresources have "/" in their name (e.g., "pods/log", "pods/status").
    // These are sub-endpoints on real resources, not standalone types.
    if (r.name.includes("/")) return false;

    // Resources in the exclusion list are internal plumbing.
    if (EXCLUDED_RESOURCE_NAMES.has(r.name)) return false;

    // Resources without "get" verb can't be inspected with kubectl explain.
    // This also filters out write-only resources like bindings and tokenreviews.
    if (!r.verbs.includes("get")) return false;

    return true;
  });
}

// ---------------------------------------------------------------------------
// Main orchestrator
// ---------------------------------------------------------------------------

/**
 * Discovers all resource types in the cluster, filters out low-value ones,
 * and extracts their schemas for LLM analysis.
 *
 * This is the main entry point for M1. It orchestrates three kubectl commands:
 * 1. `kubectl api-resources -o wide` — lists all resource types
 * 2. `kubectl get crd -o json` — identifies which resources are CRDs
 * 3. `kubectl explain <resource> --recursive` — extracts schema per resource
 *
 * @param options - Injectable kubectl executor and progress callback for testing
 * @returns Array of discovered resources with schemas, ready for M2
 * @throws Error if kubectl api-resources fails (other errors are handled gracefully)
 */
export async function discoverResources(
  options?: DiscoveryOptions
): Promise<DiscoveredResource[]> {
  const kubectl = options?.kubectl ?? defaultKubectl;
  const onProgress = options?.onProgress ?? console.log; // eslint-disable-line no-console

  // Step 1: Discover all resource types
  onProgress("Discovering API resources...");
  const apiResourcesResult = kubectl(["api-resources", "-o", "wide"]);
  if (apiResourcesResult.isError) {
    throw new Error(
      `Failed to list API resources: ${apiResourcesResult.output}`
    );
  }
  const allResources = parseApiResources(apiResourcesResult.output);
  onProgress(`Found ${allResources.length} API resources.`);

  // Step 2: Get CRD names for isCRD detection
  onProgress("Checking for Custom Resource Definitions...");
  const crdNames = getCrdNames(kubectl);
  onProgress(`Found ${crdNames.size} CRDs.`);

  // Step 3: Filter out low-value resources
  const filtered = filterResources(allResources);
  onProgress(
    `After filtering: ${filtered.length} resources (removed ${allResources.length - filtered.length}).`
  );

  // Step 4: Extract schemas for each remaining resource
  const discovered: DiscoveredResource[] = [];

  for (let i = 0; i < filtered.length; i++) {
    const resource = filtered[i];
    const group = extractGroup(resource.apiVersion);
    const fqName = buildFullyQualifiedName(resource.name, group);

    onProgress(
      `Extracting schema (${i + 1} of ${filtered.length}): ${fqName}`
    );

    const explainResult = kubectl([
      "explain",
      fqName,
      "--recursive",
    ]);

    // Skip resources where kubectl explain fails (e.g., missing CRD schema).
    // Log a warning but don't abort the whole pipeline.
    if (explainResult.isError) {
      onProgress(`  Warning: skipping ${fqName} (kubectl explain failed)`);
      continue;
    }

    discovered.push({
      name: fqName,
      apiVersion: resource.apiVersion,
      group,
      kind: resource.kind,
      namespaced: resource.namespaced,
      isCRD: crdNames.has(fqName),
      schema: explainResult.output,
    });
  }

  onProgress(
    `Discovery complete: ${discovered.length} resources with schemas.`
  );
  return discovered;
}

/**
 * Fetches the list of CRD names from the cluster.
 *
 * Runs `kubectl get crd -o json` and extracts metadata.name from each item.
 * CRD names are fully qualified (e.g., "sqls.devopstoolkit.live"), matching
 * the format returned by buildFullyQualifiedName.
 *
 * Returns an empty set if the command fails (cluster might not have CRDs).
 */
function getCrdNames(
  kubectl: (args: string[]) => { output: string; isError: boolean }
): Set<string> {
  const result = kubectl(["get", "crd", "-o", "json"]);

  if (result.isError) {
    return new Set();
  }

  try {
    const parsed = JSON.parse(result.output);
    const names = (parsed.items || []).map(
      (item: { metadata: { name: string } }) => item.metadata.name
    );
    return new Set(names);
  } catch {
    return new Set();
  }
}
