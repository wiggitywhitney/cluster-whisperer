/**
 * types.ts - Shared data types for the capability inference pipeline
 *
 * These types flow through the pipeline milestones:
 * - M1 (Discovery) produces DiscoveredResource[]
 * - M2 (Inference) consumes DiscoveredResource[], produces ResourceCapability[]
 * - M3 (Storage) consumes ResourceCapability[], stores in vector DB
 */

/**
 * Intermediate representation from parsing kubectl api-resources output.
 * Contains metadata about a Kubernetes resource type before schema extraction.
 */
export interface ParsedApiResource {
  /** Plural resource name (e.g., "deployments", "sqls") */
  name: string;
  /** Comma-separated short names (e.g., "deploy"), empty string if none */
  shortNames: string;
  /** Full API version (e.g., "apps/v1", "v1", "devopstoolkit.live/v1beta1") */
  apiVersion: string;
  /** Whether resources of this type are namespace-scoped */
  namespaced: boolean;
  /** Kind name (e.g., "Deployment", "SQL") */
  kind: string;
  /** Available API verbs (e.g., ["get", "list", "create"]) */
  verbs: string[];
  /** Resource categories (e.g., ["all"]), empty array if none */
  categories: string[];
}

/**
 * A fully discovered resource with its schema, ready for LLM analysis in M2.
 * This is the final output of the M1 discovery pipeline.
 */
export interface DiscoveredResource {
  /** Fully qualified resource name (e.g., "deployments.apps", "sqls.devopstoolkit.live") */
  name: string;
  /** Full API version (e.g., "apps/v1", "devopstoolkit.live/v1beta1") */
  apiVersion: string;
  /** API group (e.g., "apps", "devopstoolkit.live", "" for core) */
  group: string;
  /** Kind name (e.g., "Deployment", "SQL") */
  kind: string;
  /** Whether resources of this type are namespace-scoped */
  namespaced: boolean;
  /** Whether this is a Custom Resource Definition */
  isCRD: boolean;
  /** kubectl explain --recursive output for LLM analysis */
  schema: string;
}

/**
 * Options for the discoverResources function.
 * Accepts injectable dependencies for testing.
 */
export interface DiscoveryOptions {
  /**
   * Injectable kubectl executor for testing.
   * Defaults to the real executeKubectl from utils/kubectl.
   */
  kubectl?: (args: string[]) => { output: string; isError: boolean };
  /**
   * Progress callback for long-running operations.
   * Called during schema extraction with messages like "Extracting schemas... (3 of 47)"
   * Defaults to console.log.
   */
  onProgress?: (message: string) => void;
}
