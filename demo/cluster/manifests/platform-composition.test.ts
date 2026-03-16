// ABOUTME: Tests for the platform ManagedService XRD and Composition manifests.
// ABOUTME: Validates YAML structure, required fields, and description richness for the inference pipeline.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseAllDocuments } from "yaml";

const MANIFESTS_DIR = join(__dirname);

/**
 * Parse a multi-document YAML file into an array of JS objects.
 */
function loadYamlDocs(filename: string): Record<string, unknown>[] {
  const content = readFileSync(join(MANIFESTS_DIR, filename), "utf-8");
  return parseAllDocuments(content).map((doc) => doc.toJSON());
}

describe("Platform ManagedService XRD (xrd.yaml)", () => {
  const docs = loadYamlDocs("xrd.yaml");
  const xrd = docs[0] as Record<string, unknown>;

  it("is a valid CompositeResourceDefinition", () => {
    expect(xrd.apiVersion).toBe("apiextensions.crossplane.io/v2");
    expect(xrd.kind).toBe("CompositeResourceDefinition");
  });

  it("defines ManagedService kind in platform group", () => {
    const spec = xrd.spec as Record<string, unknown>;
    expect(spec.group).toBe("platform.acme.io");

    const names = spec.names as Record<string, string>;
    expect(names.kind).toBe("ManagedService");
    expect(names.plural).toBe("managedservices");
  });

  it("metadata name matches {plural}.{group} convention", () => {
    const metadata = xrd.metadata as Record<string, unknown>;
    const spec = xrd.spec as Record<string, unknown>;
    const names = spec.names as Record<string, string>;
    expect(metadata.name).toBe(`${names.plural}.${spec.group}`);
  });

  it("has exactly one version that is served and referenceable", () => {
    const spec = xrd.spec as Record<string, unknown>;
    const versions = spec.versions as Record<string, unknown>[];
    expect(versions).toHaveLength(1);
    expect(versions[0].served).toBe(true);
    expect(versions[0].referenceable).toBe(true);
  });

  it("has a rich OpenAPI schema with spec properties", () => {
    const spec = xrd.spec as Record<string, unknown>;
    const versions = spec.versions as Record<string, unknown>[];
    const schema = versions[0].schema as Record<string, unknown>;
    const openAPI = schema.openAPIV3Schema as Record<string, unknown>;

    expect(openAPI.type).toBe("object");

    const props = openAPI.properties as Record<string, unknown>;
    expect(props.spec).toBeDefined();

    const specProps = (props.spec as Record<string, unknown>)
      .properties as Record<string, unknown>;
    expect(Object.keys(specProps).length).toBeGreaterThanOrEqual(3);
  });

  it("has descriptions on all user-facing spec properties", () => {
    const spec = xrd.spec as Record<string, unknown>;
    const versions = spec.versions as Record<string, unknown>[];
    const schema = versions[0].schema as Record<string, unknown>;
    const openAPI = schema.openAPIV3Schema as Record<string, unknown>;
    const props = openAPI.properties as Record<string, unknown>;
    const specSchema = props.spec as Record<string, unknown>;
    const specProps = specSchema.properties as Record<string, unknown>;

    // Every top-level spec property must have a description for kubectl explain
    for (const [key, value] of Object.entries(specProps)) {
      const prop = value as Record<string, unknown>;
      expect(prop.description, `spec.${key} missing description`).toBeTruthy();
    }
  });

  it("includes database-relevant fields for inference pipeline discovery", () => {
    const spec = xrd.spec as Record<string, unknown>;
    const versions = spec.versions as Record<string, unknown>[];
    const schema = versions[0].schema as Record<string, unknown>;
    const openAPI = schema.openAPIV3Schema as Record<string, unknown>;
    const props = openAPI.properties as Record<string, unknown>;
    const specSchema = props.spec as Record<string, unknown>;
    const specProps = specSchema.properties as Record<string, unknown>;
    const fieldNames = Object.keys(specProps);

    // Must include fields that signal "this is a database resource"
    // so the inference pipeline generates a meaningful description
    expect(fieldNames).toContain("engine");
    expect(fieldNames).toContain("storageGB");
  });

  it("mentions PostgreSQL in field descriptions or enum values", () => {
    const spec = xrd.spec as Record<string, unknown>;
    const versions = spec.versions as Record<string, unknown>[];
    const schema = versions[0].schema as Record<string, unknown>;
    const yaml = JSON.stringify(schema).toLowerCase();

    expect(yaml).toContain("postgresql");
  });
});

describe("Platform ManagedService Composition (composition.yaml)", () => {
  const docs = loadYamlDocs("composition.yaml");
  const composition = docs[0] as Record<string, unknown>;

  it("is a valid Composition", () => {
    expect(composition.apiVersion).toBe("apiextensions.crossplane.io/v1");
    expect(composition.kind).toBe("Composition");
  });

  it("references the ManagedService XRD", () => {
    const spec = composition.spec as Record<string, unknown>;
    const typeRef = spec.compositeTypeRef as Record<string, string>;
    expect(typeRef.apiVersion).toBe("platform.acme.io/v1alpha1");
    expect(typeRef.kind).toBe("ManagedService");
  });

  it("uses Pipeline mode (required in Crossplane v2)", () => {
    const spec = composition.spec as Record<string, unknown>;
    expect(spec.mode).toBe("Pipeline");
    expect(spec.pipeline).toBeDefined();

    const pipeline = spec.pipeline as Record<string, unknown>[];
    expect(pipeline.length).toBeGreaterThanOrEqual(1);
  });

  it("references function-patch-and-transform", () => {
    const spec = composition.spec as Record<string, unknown>;
    const pipeline = spec.pipeline as Record<string, unknown>[];
    const step = pipeline[0];
    const functionRef = step.functionRef as Record<string, string>;

    expect(functionRef.name).toBe(
      "crossplane-contrib-function-patch-and-transform"
    );
  });

  it("maps to in-cluster PostgreSQL resources", () => {
    const yaml = JSON.stringify(composition).toLowerCase();
    expect(yaml).toContain("postgresql");
    expect(yaml).toContain("db-service");
  });

  it("creates a Deployment and Service for PostgreSQL", () => {
    const spec = composition.spec as Record<string, unknown>;
    const pipeline = spec.pipeline as Record<string, unknown>[];
    const step = pipeline[0];
    const input = step.input as Record<string, unknown>;
    const resources = input.resources as Record<string, unknown>[];

    // Should have at least a Deployment and a Service resource
    const resourceNames = resources.map((r) => (r as Record<string, string>).name);
    expect(resourceNames).toContain("postgresql-deployment");
    expect(resourceNames).toContain("postgresql-service");
  });
});
