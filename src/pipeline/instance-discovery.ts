/**
 * instance-discovery.ts - Resource instance discovery for the instance sync pipeline (PRD #26 M1)
 *
 * Discovers all running resource instances in a Kubernetes cluster and extracts
 * their metadata for storage in the vector database. This enables the agent to
 * answer questions like "what databases are running?" by searching across all
 * resource types in a single query.
 *
 * Three-step flow:
 * 1. Enumerate — kubectl api-resources to find all resource types
 * 2. Filter — Remove subresources, high-churn resources, and resources without list verb
 * 3. List — kubectl get <type> -A -o json for each resource type, extract metadata
 *
 * The output (ResourceInstance[]) feeds directly into PRD #26 M2's storage pipeline.
 *
 * This module reuses the api-resources parsing and filtering functions from
 * discovery.ts (PRD #25) since both pipelines need to enumerate resource types.
 * The key difference: capability inference extracts schemas (kubectl explain),
 * while instance sync lists actual running objects (kubectl get).
 */

import { executeKubectl as defaultKubectl } from "../utils/kubectl";
import {
  parseApiResources,
  filterResources,
  extractGroup,
} from "./discovery";
import type {
  ResourceInstance,
  InstanceDiscoveryOptions,
  ParsedApiResource,
} from "./types";

// ---------------------------------------------------------------------------
// Pure functions (exported for unit testing)
// ---------------------------------------------------------------------------

/**
 * Annotation keys that represent descriptions worth syncing.
 *
 * Most annotations are operational metadata (checksums, revisions, configs)
 * that don't help with semantic search. Description annotations are the
 * exception — they contain human-written text about what the resource does.
 *
 * An annotation is considered "description-like" if its key is exactly
 * "description" or ends with "/description" (the Kubernetes label convention
 * for namespaced keys, e.g., "app.kubernetes.io/description").
 */
export function filterDescriptionAnnotations(
  annotations: Record<string, string> | undefined
): Record<string, string> {
  if (!annotations) return {};

  const filtered: Record<string, string> = {};
  for (const [key, value] of Object.entries(annotations)) {
    if (key === "description" || key.endsWith("/description")) {
      filtered[key] = value;
    }
  }
  return filtered;
}

/**
 * Builds the canonical instance ID.
 *
 * Format: "namespace/apiVersion/Kind/name"
 * Examples:
 *   "default/apps/v1/Deployment/nginx"
 *   "_cluster/v1/Namespace/kube-system"
 *   "databases/devopstoolkit.live/v1beta1/SQL/my-db"
 *
 * The ID uniquely identifies an instance across the entire cluster.
 * Using apiVersion (not apiGroup) ensures uniqueness even if a resource
 * exists in multiple API versions.
 */
export function buildInstanceId(
  namespace: string,
  apiVersion: string,
  kind: string,
  name: string
): string {
  return `${namespace}/${apiVersion}/${kind}/${name}`;
}

/**
 * Parses the JSON output of `kubectl get <type> -o json` into ResourceInstance[].
 *
 * kubectl returns a Kubernetes List object containing an items array.
 * Each item has metadata (name, namespace, labels, annotations, creationTimestamp)
 * that we extract into the flat ResourceInstance structure.
 *
 * The kind and apiVersion are passed in rather than read from each item because
 * kubectl sometimes returns the List kind/apiVersion rather than the individual
 * item kind/apiVersion (e.g., "DeploymentList" instead of "Deployment").
 *
 * @param json - Raw JSON string from kubectl get -o json
 * @param kind - Resource kind for all items (e.g., "Deployment")
 * @param apiVersion - Full API version for all items (e.g., "apps/v1")
 * @param namespaced - Whether this resource type is namespace-scoped
 * @returns Parsed instances with metadata
 */
export function parseInstanceList(
  json: string,
  kind: string,
  apiVersion: string,
  namespaced: boolean
): ResourceInstance[] {
  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    throw new Error(
      `Failed to parse ${kind} (${apiVersion}) instances: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  const items: Array<{
    metadata?: {
      name?: string;
      namespace?: string;
      labels?: Record<string, string>;
      annotations?: Record<string, string>;
      creationTimestamp?: string;
    };
  }> = parsed.items || [];

  const apiGroup = extractGroup(apiVersion);

  return items.map((item) => {
    const metadata = item.metadata || {};
    const name = metadata.name || "";
    const namespace = namespaced
      ? (metadata.namespace || "default")
      : "_cluster";
    const labels = metadata.labels || {};
    const annotations = filterDescriptionAnnotations(metadata.annotations);
    const createdAt = metadata.creationTimestamp || "";

    return {
      id: buildInstanceId(namespace, apiVersion, kind, name),
      namespace,
      name,
      kind,
      apiVersion,
      apiGroup,
      labels,
      annotations,
      createdAt,
    };
  });
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Filters resource types for instance discovery.
 *
 * Reuses PRD #25's filterResources() which removes subresources, excluded names,
 * and resources without "get" verb. Additionally requires the "list" verb since
 * we need to enumerate all instances of each type.
 */
function filterForInstanceDiscovery(
  resources: ParsedApiResource[]
): ParsedApiResource[] {
  return filterResources(resources).filter((r) => r.verbs.includes("list"));
}

/**
 * Applies the optional resourceTypes filter to narrow which types are synced.
 *
 * When resourceTypes is provided, only resource types whose plural name
 * matches an entry in the list are included. This lets callers focus on
 * specific types (e.g., ["deployments", "services"]) rather than syncing
 * everything.
 */
function applyResourceTypeFilter(
  resources: ParsedApiResource[],
  resourceTypes?: string[]
): ParsedApiResource[] {
  if (!resourceTypes || resourceTypes.length === 0) return resources;

  const allowed = new Set(resourceTypes);
  return resources.filter((r) => allowed.has(r.name));
}

// ---------------------------------------------------------------------------
// Main orchestrator
// ---------------------------------------------------------------------------

/**
 * Discovers all resource instances in the cluster and extracts their metadata.
 *
 * This is the main entry point for PRD #26 M1. It orchestrates:
 * 1. `kubectl api-resources -o wide` — lists all resource types
 * 2. Filter and (optionally) narrow resource types
 * 3. `kubectl get <type> -A -o json` per type — lists all instances
 *
 * @param options - Injectable kubectl executor, progress callback, optional type filter
 * @returns Array of resource instances with metadata, ready for M2 storage
 * @throws Error if kubectl api-resources fails (other errors are handled gracefully)
 */
export async function discoverInstances(
  options?: InstanceDiscoveryOptions
): Promise<ResourceInstance[]> {
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

  // Step 2: Filter out low-value resources and require list verb
  const filtered = filterForInstanceDiscovery(allResources);
  onProgress(
    `After filtering: ${filtered.length} resource types (removed ${allResources.length - filtered.length}).`
  );

  // Step 3: Apply optional resource type filter
  const targeted = applyResourceTypeFilter(filtered, options?.resourceTypes);
  if (options?.resourceTypes) {
    onProgress(
      `Targeting ${targeted.length} resource types (from ${options.resourceTypes.length} requested).`
    );
  }

  // Step 4: List instances for each resource type
  const allInstances: ResourceInstance[] = [];

  for (let i = 0; i < targeted.length; i++) {
    const resource = targeted[i];
    const group = extractGroup(resource.apiVersion);
    const fqName = group ? `${resource.name}.${group}` : resource.name;

    onProgress(
      `Listing instances (${i + 1} of ${targeted.length}): ${fqName}`
    );

    // Build kubectl get args: namespaced resources use -A for all namespaces
    const getArgs = ["get", resource.name];
    if (resource.namespaced) {
      getArgs.push("-A");
    }
    getArgs.push("-o", "json");

    const getResult = kubectl(getArgs);

    // Skip resource types where kubectl get fails (e.g., RBAC forbidden).
    // Log a warning but don't abort the whole pipeline.
    if (getResult.isError) {
      onProgress(`  Warning: skipping ${fqName} (kubectl get failed)`);
      continue;
    }

    const instances = parseInstanceList(
      getResult.output,
      resource.kind,
      resource.apiVersion,
      resource.namespaced
    );
    allInstances.push(...instances);
  }

  onProgress(
    `Discovery complete: ${allInstances.length} instances across ${targeted.length} resource types.`
  );
  return allInstances;
}
