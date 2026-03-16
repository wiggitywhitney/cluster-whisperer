// ABOUTME: Re-exports all core tool functions, schemas, and descriptions
// ABOUTME: Import from here for shared logic without framework wrappers

/**
 * Core tools - Shared logic for all interfaces
 *
 * This module re-exports all core tool functions, schemas, and descriptions.
 * Import from here when you need the shared logic without framework wrappers.
 *
 * Usage:
 *   import { kubectlGet, kubectlGetSchema } from "./tools/core";
 */

export {
  kubectlGet,
  kubectlGetSchema,
  kubectlGetDescription,
  type KubectlGetInput,
} from "./kubectl-get";

export {
  kubectlDescribe,
  kubectlDescribeSchema,
  kubectlDescribeDescription,
  type KubectlDescribeInput,
} from "./kubectl-describe";

export {
  kubectlLogs,
  kubectlLogsSchema,
  kubectlLogsDescription,
  type KubectlLogsInput,
} from "./kubectl-logs";

export {
  vectorSearch,
  vectorSearchSchema,
  vectorSearchDescription,
  type VectorSearchInput,
} from "./vector-search";

export {
  kubectlApply,
  kubectlApplySchema,
  kubectlApplyDescription,
  parseManifestMetadata,
  type KubectlApplyInput,
} from "./kubectl-apply";

export { formatSearchResults } from "./format-results";

export { type KubectlOptions } from "../../utils/kubectl";
