/**
 * pipeline/index.ts - Public API for the capability inference pipeline
 *
 * Re-exports everything other modules need from the pipeline.
 * Import from here — never import directly from discovery.ts or types.ts.
 *
 * Usage:
 *   import {
 *     discoverResources,
 *     type DiscoveredResource,
 *   } from "./pipeline";
 */

// Types shared across pipeline milestones
export type {
  ParsedApiResource,
  DiscoveredResource,
  DiscoveryOptions,
} from "./types";

// M1: CRD Discovery
export {
  discoverResources,
  parseApiResources,
  filterResources,
  extractGroup,
  buildFullyQualifiedName,
} from "./discovery";
