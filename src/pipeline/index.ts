/**
 * pipeline/index.ts - Public API for the capability inference pipeline
 *
 * Re-exports everything other modules need from the pipeline.
 * Import from here — never import directly from discovery.ts or types.ts.
 *
 * Usage:
 *   import {
 *     discoverResources,
 *     inferCapabilities,
 *     type DiscoveredResource,
 *     type ResourceCapability,
 *   } from "./pipeline";
 */

// Types shared across pipeline milestones
export type {
  ParsedApiResource,
  DiscoveredResource,
  DiscoveryOptions,
  ResourceCapability,
  LlmCapabilityResult,
  InferenceOptions,
  StorageOptions,
} from "./types";

// M1: CRD Discovery
export {
  discoverResources,
  parseApiResources,
  filterResources,
  extractGroup,
  buildFullyQualifiedName,
} from "./discovery";

// M2: LLM Inference
export { inferCapability, inferCapabilities, LlmCapabilitySchema } from "./inference";

// M3: Vector Storage
export { capabilityToDocument, storeCapabilities } from "./storage";

// M4: Pipeline Runner
export { syncCapabilities } from "./runner";
export type { SyncOptions, SyncResult } from "./runner";

// PRD #26: Resource Instance Sync
export type {
  ResourceInstance,
  InstanceDiscoveryOptions,
} from "./types";
export { discoverInstances } from "./instance-discovery";
export { instanceToDocument, storeInstances } from "./instance-storage";
export { syncInstances } from "./instance-runner";
export type {
  SyncInstancesOptions,
  SyncInstancesResult,
} from "./instance-runner";
