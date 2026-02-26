/**
 * scan-payload.test.ts - Unit tests for the capability scan Zod schema (PRD #42 M1)
 *
 * Validates that the schema correctly parses the controller's CRD scan payload,
 * rejects malformed input, and applies defaults for optional/null fields.
 */

import { describe, it, expect } from "vitest";
import { ScanPayloadSchema } from "./scan-payload";

describe("ScanPayloadSchema", () => {
  it("accepts a full payload with upserts and deletes", () => {
    const result = ScanPayloadSchema.safeParse({
      upserts: ["certificates.cert-manager.io", "issuers.cert-manager.io"],
      deletes: ["old-resource.example.io"],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.upserts).toEqual([
        "certificates.cert-manager.io",
        "issuers.cert-manager.io",
      ]);
      expect(result.data.deletes).toEqual(["old-resource.example.io"]);
    }
  });

  it("defaults upserts to empty array when omitted", () => {
    const result = ScanPayloadSchema.safeParse({
      deletes: ["old-resource.example.io"],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.upserts).toEqual([]);
    }
  });

  it("defaults deletes to empty array when omitted", () => {
    const result = ScanPayloadSchema.safeParse({
      upserts: ["certificates.cert-manager.io"],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.deletes).toEqual([]);
    }
  });

  it("accepts null upserts (Go nil slice serializes as JSON null)", () => {
    const result = ScanPayloadSchema.safeParse({
      upserts: null,
      deletes: ["old-resource.example.io"],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.upserts).toEqual([]);
    }
  });

  it("accepts null deletes (Go nil slice serializes as JSON null)", () => {
    const result = ScanPayloadSchema.safeParse({
      upserts: ["certificates.cert-manager.io"],
      deletes: null,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.deletes).toEqual([]);
    }
  });

  it("accepts empty payload (both arrays empty)", () => {
    const result = ScanPayloadSchema.safeParse({
      upserts: [],
      deletes: [],
    });
    expect(result.success).toBe(true);
  });

  it("accepts empty object (defaults both arrays)", () => {
    const result = ScanPayloadSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.upserts).toEqual([]);
      expect(result.data.deletes).toEqual([]);
    }
  });

  it("rejects upserts with non-string values", () => {
    const result = ScanPayloadSchema.safeParse({
      upserts: [123],
    });
    expect(result.success).toBe(false);
  });

  it("rejects deletes with non-string values", () => {
    const result = ScanPayloadSchema.safeParse({
      deletes: [{ name: "foo" }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects non-object payload", () => {
    const result = ScanPayloadSchema.safeParse("not an object");
    expect(result.success).toBe(false);
  });

  it("rejects array payload", () => {
    const result = ScanPayloadSchema.safeParse(["certificates.cert-manager.io"]);
    expect(result.success).toBe(false);
  });
});
