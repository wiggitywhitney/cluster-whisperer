/**
 * scan-payload.ts - Zod schema for the capability scan endpoint (PRD #42 M1)
 *
 * Validates the JSON payload pushed by the k8s-vectordb-sync controller when
 * it detects CRD add/delete events. The controller sends fully qualified
 * resource names (e.g., "certificates.cert-manager.io") — not full resource
 * objects like the instance sync endpoint.
 *
 * The ScanPayloadSchema matches the controller's Go CrdSyncPayload struct.
 * Both arrays use the same nullable+transform pattern as the instance sync
 * schema to handle Go nil slices serializing as JSON null.
 */

import { z } from "zod";

/**
 * Schema for the capability scan payload sent by the controller.
 *
 * Both arrays are nullable because Go nil slices serialize as JSON null.
 * They also default to empty when omitted entirely.
 */
export const ScanPayloadSchema = z.object({
  /** Fully qualified CRD names to scan and store capabilities for */
  upserts: z
    .array(z.string())
    .nullable()
    .transform((v) => v ?? [])
    .default([]),
  /** Fully qualified CRD names to remove from the capabilities collection */
  deletes: z
    .array(z.string())
    .nullable()
    .transform((v) => v ?? [])
    .default([]),
});

/** TypeScript type inferred from the validated payload */
export type ScanPayload = z.infer<typeof ScanPayloadSchema>;
