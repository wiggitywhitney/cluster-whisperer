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
   * Defaults to stdout.
   */
  onProgress?: (message: string) => void;
}

// ---------------------------------------------------------------------------
// M2: LLM Inference types
// ---------------------------------------------------------------------------

/**
 * A structured capability description for a Kubernetes resource type.
 *
 * Combines metadata from the cluster (resourceName, apiVersion, group, kind)
 * with LLM-inferred semantic fields (capabilities, providers, complexity,
 * description, useCase, confidence).
 *
 * This is the main data structure that flows from M2 (inference) into M3
 * (vector storage) and ultimately powers semantic search — "how do I deploy
 * a database?" matches resources whose capabilities include "database".
 */
export interface ResourceCapability {
  /** Fully qualified resource name (e.g., "sqls.devopstoolkit.live") */
  resourceName: string;
  /** Full API version (e.g., "devopstoolkit.live/v1beta1") */
  apiVersion: string;
  /** API group (e.g., "devopstoolkit.live", "" for core) */
  group: string;
  /** Kind name (e.g., "SQL") */
  kind: string;

  // --- LLM-inferred fields below ---

  /** Functional capabilities this resource provides (e.g., ["postgresql", "mysql", "database"]) */
  capabilities: string[];
  /** Cloud providers this resource supports (e.g., ["aws", "gcp", "azure"]) */
  providers: string[];
  /** How complex the resource is to use */
  complexity: "low" | "medium" | "high";
  /** Human-readable description of what the resource does */
  description: string;
  /** When and why a developer would use this resource */
  useCase: string;
  /** LLM's confidence in its analysis (0 = guessing, 1 = certain) */
  confidence: number;
}

/**
 * The subset of ResourceCapability fields that come from the LLM.
 *
 * Derived from ResourceCapability via Omit so the two types stay structurally
 * coupled. The remaining fields (resourceName, apiVersion, group, kind) are
 * copied from the DiscoveredResource input — no need for the LLM to repeat them.
 */
export type LlmCapabilityResult = Omit<
  ResourceCapability,
  "resourceName" | "apiVersion" | "group" | "kind"
>;

/**
 * Options for the inference pipeline functions.
 * Accepts injectable dependencies for testing.
 */
export interface InferenceOptions {
  /**
   * Injectable structured model for testing.
   *
   * Must accept an array of BaseMessage-like objects and return the
   * LLM-inferred fields. In production, this is a ChatAnthropic instance
   * with withStructuredOutput(). In tests, a simple mock object.
   *
   * Defaults to ChatAnthropic Haiku with Zod structured output.
   */
  model?: {
    invoke: (messages: Array<[string, string]>) => Promise<LlmCapabilityResult>;
  };
  /**
   * Progress callback for long-running operations.
   * Called with messages like "Inferring capabilities (3 of 47): sqls.devopstoolkit.live"
   * Defaults to stdout.
   */
  onProgress?: (message: string) => void;
}

// ---------------------------------------------------------------------------
// M3: Storage types
// ---------------------------------------------------------------------------

/**
 * Options for the storage pipeline functions.
 * Accepts injectable dependencies for testing.
 *
 * The VectorStore is injected rather than imported directly so that:
 * - Unit tests can use a mock (no Chroma server needed)
 * - Integration tests can use a real ChromaBackend
 * - The storage code stays backend-agnostic
 */
export interface StorageOptions {
  /**
   * Progress callback for long-running operations.
   * Called with messages like "Storing capabilities (3 of 47)"
   * Defaults to stdout.
   */
  onProgress?: (message: string) => void;
}
