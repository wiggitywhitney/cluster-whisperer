/**
 * sync-payload.test.ts - Unit tests for the sync payload Zod schemas (PRD #35 M2)
 *
 * Validates that the Zod schema correctly parses the controller's payload
 * format, rejects malformed input, and applies defaults for optional fields.
 */

import { describe, it, expect } from "vitest";
import { SyncPayloadSchema, ResourceInstanceSchema } from "./sync-payload";
import { makeInstance } from "../test-helpers";

// ---------------------------------------------------------------------------
// ResourceInstanceSchema
// ---------------------------------------------------------------------------

describe("ResourceInstanceSchema", () => {
  it("accepts a valid resource instance", () => {
    const result = ResourceInstanceSchema.safeParse(makeInstance());
    expect(result.success).toBe(true);
  });

  it("defaults labels to empty object when omitted", () => {
    const { labels: _, ...noLabels } = makeInstance();
    const result = ResourceInstanceSchema.safeParse(noLabels);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.labels).toEqual({});
    }
  });

  it("defaults annotations to empty object when omitted", () => {
    const { annotations: _, ...noAnnotations } = makeInstance();
    const result = ResourceInstanceSchema.safeParse(noAnnotations);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.annotations).toEqual({});
    }
  });

  it("rejects instance missing required fields", () => {
    const result = ResourceInstanceSchema.safeParse({ id: "foo" });
    expect(result.success).toBe(false);
  });

  it("rejects non-string field values", () => {
    const result = ResourceInstanceSchema.safeParse(
      makeInstance({ name: 123 })
    );
    expect(result.success).toBe(false);
  });

  it("rejects labels with non-string values", () => {
    const result = ResourceInstanceSchema.safeParse(
      makeInstance({ labels: { count: 42 } })
    );
    expect(result.success).toBe(false);
  });

  it("accepts null labels (Go nil map serializes as JSON null)", () => {
    const result = ResourceInstanceSchema.safeParse(
      makeInstance({ labels: null })
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.labels).toEqual({});
    }
  });

  it("accepts null annotations (Go nil map serializes as JSON null)", () => {
    const result = ResourceInstanceSchema.safeParse(
      makeInstance({ annotations: null })
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.annotations).toEqual({});
    }
  });
});

// ---------------------------------------------------------------------------
// SyncPayloadSchema
// ---------------------------------------------------------------------------

describe("SyncPayloadSchema", () => {
  it("accepts a full payload with upserts and deletes", () => {
    const result = SyncPayloadSchema.safeParse({
      upserts: [makeInstance()],
      deletes: ["default/apps/v1/Deployment/old-service"],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.upserts).toHaveLength(1);
      expect(result.data.deletes).toHaveLength(1);
    }
  });

  it("defaults upserts to empty array when omitted", () => {
    const result = SyncPayloadSchema.safeParse({
      deletes: ["some/id"],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.upserts).toEqual([]);
    }
  });

  it("defaults deletes to empty array when omitted", () => {
    const result = SyncPayloadSchema.safeParse({
      upserts: [makeInstance()],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.deletes).toEqual([]);
    }
  });

  it("accepts null upserts (Go nil slice serializes as JSON null)", () => {
    const result = SyncPayloadSchema.safeParse({
      upserts: null,
      deletes: ["some/id"],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.upserts).toEqual([]);
    }
  });

  it("accepts null deletes (Go nil slice serializes as JSON null)", () => {
    const result = SyncPayloadSchema.safeParse({
      upserts: [makeInstance()],
      deletes: null,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.deletes).toEqual([]);
    }
  });

  it("accepts empty payload (both arrays empty)", () => {
    const result = SyncPayloadSchema.safeParse({
      upserts: [],
      deletes: [],
    });
    expect(result.success).toBe(true);
  });

  it("accepts empty object (defaults both arrays)", () => {
    const result = SyncPayloadSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.upserts).toEqual([]);
      expect(result.data.deletes).toEqual([]);
    }
  });

  it("accepts multiple upserts", () => {
    const result = SyncPayloadSchema.safeParse({
      upserts: [
        makeInstance(),
        makeInstance({ id: "kube-system/v1/Service/kube-dns", name: "kube-dns", kind: "Service" }),
      ],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.upserts).toHaveLength(2);
    }
  });

  it("rejects upserts with invalid instance shape", () => {
    const result = SyncPayloadSchema.safeParse({
      upserts: [{ notValid: true }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects deletes with non-string values", () => {
    const result = SyncPayloadSchema.safeParse({
      deletes: [123],
    });
    expect(result.success).toBe(false);
  });

  it("rejects non-object payload", () => {
    const result = SyncPayloadSchema.safeParse("not an object");
    expect(result.success).toBe(false);
  });

  it("rejects array payload", () => {
    const result = SyncPayloadSchema.safeParse([makeInstance()]);
    expect(result.success).toBe(false);
  });
});
