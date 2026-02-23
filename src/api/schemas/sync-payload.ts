/**
 * sync-payload.ts - Zod schemas for the instance sync endpoint (PRD #35 M2)
 *
 * Validates the JSON payload pushed by the k8s-vectordb-sync controller.
 * The controller watches Kubernetes clusters and sends batched resource
 * changes as upserts (new/updated instances) and deletes (removed instances).
 *
 * The ResourceInstanceSchema matches the controller's Go ResourceInstance
 * struct and the existing TypeScript ResourceInstance type in pipeline/types.ts.
 * No type conversion layer needed — the controller's JSON output is the
 * endpoint's input.
 */

import { z } from "zod";

/**
 * Schema for a single resource instance in the upserts array.
 *
 * Maps 1:1 with the ResourceInstance interface in pipeline/types.ts
 * and the controller's Go struct. Labels and annotations default to
 * empty objects since the controller omits them for resources with none.
 */
export const ResourceInstanceSchema = z.object({
  /** Canonical ID: "namespace/apiVersion/Kind/name" */
  id: z.string(),
  /** Namespace or "_cluster" for cluster-scoped resources */
  namespace: z.string(),
  /** Instance name from metadata.name */
  name: z.string(),
  /** Resource kind (e.g., "Deployment", "Service") */
  kind: z.string(),
  /** Full API version (e.g., "apps/v1", "v1") */
  apiVersion: z.string(),
  /** API group (e.g., "apps", "" for core resources) */
  apiGroup: z.string(),
  /** Labels from metadata.labels — nullable because Go nil maps serialize as JSON null */
  labels: z
    .record(z.string())
    .nullable()
    .transform((v) => v ?? {})
    .default({}),
  /** Filtered annotations — nullable for the same Go nil reason */
  annotations: z
    .record(z.string())
    .nullable()
    .transform((v) => v ?? {})
    .default({}),
  /** ISO-8601 UTC timestamp from metadata.creationTimestamp */
  createdAt: z.string(),
});

/**
 * Schema for the full sync payload sent by the controller.
 *
 * Both arrays are nullable because Go nil slices serialize as JSON null.
 * They also default to empty when omitted entirely. The nullable+transform
 * pattern matches how labels/annotations handle Go nil maps above.
 */
export const SyncPayloadSchema = z.object({
  /** Instances to create or update in the vector DB */
  upserts: z
    .array(ResourceInstanceSchema)
    .nullable()
    .transform((v) => v ?? [])
    .default([]),
  /** Instance IDs to remove from the vector DB */
  deletes: z
    .array(z.string())
    .nullable()
    .transform((v) => v ?? [])
    .default([]),
});

/** TypeScript type inferred from the validated payload */
export type SyncPayload = z.infer<typeof SyncPayloadSchema>;
