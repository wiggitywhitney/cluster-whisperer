// ABOUTME: Unit tests for the kyverno-allowlist.yaml ClusterPolicy manifest.
// ABOUTME: Validates structure, SA scoping, deny conditions, and critical security settings.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

const MANIFEST_PATH = join(__dirname, "kyverno-allowlist.yaml");

function loadPolicy(): Record<string, unknown> {
  const content = readFileSync(MANIFEST_PATH, "utf-8");
  return parse(content) as Record<string, unknown>;
}

describe("kyverno-allowlist.yaml ClusterPolicy", () => {
  const policy = loadPolicy();

  it("is a Kyverno ClusterPolicy", () => {
    expect(policy.apiVersion).toBe("kyverno.io/v1");
    expect(policy.kind).toBe("ClusterPolicy");
  });

  it("has the correct name", () => {
    const metadata = policy.metadata as Record<string, unknown>;
    expect(metadata.name).toBe("cluster-whisperer-resource-allowlist");
  });

  describe("spec", () => {
    const spec = () => policy.spec as Record<string, unknown>;

    it("sets validationFailureAction to Enforce (not Audit)", () => {
      // Enforce blocks the request; Audit only logs it — wrong for a guardrail
      expect(spec().validationFailureAction).toBe("Enforce");
    });

    it("sets background to false", () => {
      // subjects-based matching only works on live admission requests, not background scans
      expect(spec().background).toBe(false);
    });

    it("has exactly one rule", () => {
      const rules = spec().rules as unknown[];
      expect(rules).toHaveLength(1);
    });

    describe("rule: require-approved-resources", () => {
      const rule = () => {
        const rules = spec().rules as Record<string, unknown>[];
        return rules[0];
      };

      it("has the correct rule name", () => {
        expect(rule().name).toBe("require-approved-resources");
      });

      describe("match", () => {
        const match = () => rule().match as Record<string, unknown>;

        it("uses match.any (not match.all)", () => {
          expect(match().any).toBeDefined();
        });

        it("includes kinds: ['*'] (required by Kyverno even with subject scoping)", () => {
          // Kyverno requires at least one kind in the resources block.
          // Wildcard captures all resource types so deny conditions can filter.
          const any = match().any as Record<string, unknown>[];
          const resources = any[0].resources as Record<string, unknown>;
          expect(resources.kinds).toEqual(["*"]);
        });

        it("scopes to CREATE operations only", () => {
          const any = match().any as Record<string, unknown>[];
          const resources = any[0].resources as Record<string, unknown>;
          expect(resources.operations).toEqual(["CREATE"]);
        });

        it("scopes to the cluster-whisperer-mcp ServiceAccount", () => {
          const any = match().any as Record<string, unknown>[];
          const subjects = any[0].subjects as Record<string, string>[];
          expect(subjects).toHaveLength(1);
          expect(subjects[0].kind).toBe("ServiceAccount");
          expect(subjects[0].name).toBe("cluster-whisperer-mcp");
          // namespace is required for SA kind — without it, match is ambiguous
          expect(subjects[0].namespace).toBe("cluster-whisperer");
        });

        it("subjects is a sibling of resources (not nested inside it)", () => {
          // Correct Kyverno syntax: subjects and resources are siblings under match.any[]
          const any = match().any as Record<string, unknown>[];
          const entry = any[0];
          expect(entry.resources).toBeDefined();
          expect(entry.subjects).toBeDefined();
          // subjects must NOT be inside resources
          const resources = entry.resources as Record<string, unknown>;
          expect(resources.subjects).toBeUndefined();
        });
      });

      describe("validate", () => {
        const validate = () => rule().validate as Record<string, unknown>;

        it("has a human-readable rejection message", () => {
          const message = validate().message as string;
          expect(message).toBeTruthy();
          expect(message.length).toBeGreaterThan(10);
        });

        it("uses deny conditions (not pattern matching)", () => {
          expect(validate().deny).toBeDefined();
        });

        it("denies when apiVersion is not platform.acme.io/v1alpha1", () => {
          const deny = validate().deny as Record<string, unknown>;
          const conditions = deny.conditions as Record<string, unknown>;
          const any = conditions.any as Record<string, unknown>[];
          const apiVersionCheck = any.find(
            (c) => (c.key as string).includes("apiVersion")
          );
          expect(apiVersionCheck).toBeDefined();
          expect(apiVersionCheck?.operator).toBe("NotEquals");
          expect(apiVersionCheck?.value).toBe("platform.acme.io/v1alpha1");
        });

        it("denies when kind is not ManagedService", () => {
          const deny = validate().deny as Record<string, unknown>;
          const conditions = deny.conditions as Record<string, unknown>;
          const any = conditions.any as Record<string, unknown>[];
          const kindCheck = any.find((c) =>
            (c.key as string).includes("kind")
          );
          expect(kindCheck).toBeDefined();
          expect(kindCheck?.operator).toBe("NotEquals");
          expect(kindCheck?.value).toBe("ManagedService");
        });

        it("uses any (OR) logic for deny conditions", () => {
          // Either wrong apiVersion OR wrong kind triggers the deny —
          // a resource must match BOTH allowlist criteria to pass
          const deny = validate().deny as Record<string, unknown>;
          const conditions = deny.conditions as Record<string, unknown>;
          expect(conditions.any).toBeDefined();
          expect(conditions.all).toBeUndefined();
        });
      });
    });
  });
});
