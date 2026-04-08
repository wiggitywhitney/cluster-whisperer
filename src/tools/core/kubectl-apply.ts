// ABOUTME: kubectl-apply core tool — deploys Kubernetes resources via kubectl apply
// ABOUTME: Parses YAML to validate structure, then runs kubectl apply and returns the result

/**
 * kubectl-apply core - Deploys Kubernetes resources
 *
 * This module adds a "write" tool to cluster-whisperer. Unlike the read-only
 * kubectl tools (get, describe, logs), this tool modifies the cluster by
 * applying resource manifests.
 *
 * Enforcement is handled at the cluster level:
 * - Kyverno admission control rejects non-approved resource types at admission
 * - RBAC on the cluster-whisperer ServiceAccount limits what operations are allowed
 *
 * Any rejection (Kyverno or RBAC) surfaces as a kubectl error and is returned
 * to the caller so the AI coding assistant can explain it in natural language.
 *
 * Flow:
 *   1. Parse YAML manifest → validate structure (apiVersion, kind required)
 *   2. Run `kubectl apply -f -` (pipe manifest via stdin)
 *   3. Return result, including any admission webhook errors
 */

import { z } from "zod";
import { spawnSync } from "child_process";
import { load as yamlLoad } from "js-yaml";
import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import type { KubectlResult } from "../../utils/kubectl";
import { getTracer } from "../../tracing";

/**
 * Input schema for kubectl apply.
 *
 * Takes a complete YAML manifest string. The tool parses it internally
 * to validate structure before passing to kubectl.
 */
export const kubectlApplySchema = z.object({
  manifest: z
    .string()
    .min(1, "Manifest cannot be empty")
    .describe(
      "A complete Kubernetes resource manifest in YAML format. Must include apiVersion, kind, and metadata.name at minimum."
    ),
});

export type KubectlApplyInput = z.infer<typeof kubectlApplySchema>;

/**
 * Tool description for LLMs.
 *
 * Directs the agent toward platform-approved resource types. Kyverno will
 * reject any other resource at admission — this guidance prevents wasted
 * attempts before the cluster enforces the policy.
 */
export const kubectlApplyDescription = `Deploy a Kubernetes resource by applying a YAML manifest.

IMPORTANT: Only platform-approved resource types (e.g., ManagedService from platform.acme.io) can be deployed. The cluster enforces this at admission — attempting to deploy standard Kubernetes resources (Deployment, Service, ConfigMap, etc.) will be rejected by the admission controller.

Workflow:
1. Use vector_search to discover available resource types from the platform catalog
2. Construct a YAML manifest for an approved resource type
3. Use this tool to apply the manifest

The manifest must be complete, valid YAML with at least apiVersion, kind, and metadata.name.`;

/**
 * Metadata extracted from a Kubernetes YAML manifest.
 */
interface ManifestMetadata {
  kind: string;
  apiGroup: string;
}

/**
 * Parse a YAML manifest to extract the kind and apiGroup.
 *
 * The apiGroup is derived from the apiVersion field:
 * - "apps/v1" → apiGroup "apps"
 * - "acid.zalan.do/v1" → apiGroup "acid.zalan.do"
 * - "v1" → apiGroup "" (core API, no group)
 *
 * Multi-document YAML (separated by ---) is rejected. This tool only
 * supports single-resource manifests.
 *
 * @param manifest - Raw YAML string (single document only)
 * @returns ManifestMetadata on success, or { error: string } on failure
 */
export function parseManifestMetadata(
  manifest: string
): ManifestMetadata | { error: string } {
  try {
    // Split on --- document separators and filter out empty documents.
    // A leading --- is valid YAML and produces an empty first segment,
    // so we strip those to avoid false positives.
    const documents = manifest
      .split(/^---$/m)
      .filter((doc) => doc.trim().length > 0);

    if (documents.length === 0) {
      return { error: "YAML parsed to null or non-object" };
    }

    if (documents.length > 1) {
      return {
        error:
          "Multi-document YAML is not supported. Submit one resource per apply call.",
      };
    }

    const parsed = yamlLoad(documents[0]) as Record<string, unknown> | null;

    if (!parsed || typeof parsed !== "object") {
      return { error: "YAML parsed to null or non-object" };
    }

    const kind = parsed.kind;
    const apiVersion = parsed.apiVersion;

    if (typeof kind !== "string" || !kind) {
      return { error: "Manifest is missing required field: kind" };
    }

    if (typeof apiVersion !== "string" || !apiVersion) {
      return { error: "Manifest is missing required field: apiVersion" };
    }

    // Extract apiGroup from apiVersion
    // "apps/v1" → "apps", "acid.zalan.do/v1" → "acid.zalan.do", "v1" → ""
    const slashIndex = apiVersion.lastIndexOf("/");
    const apiGroup = slashIndex === -1 ? "" : apiVersion.substring(0, slashIndex);

    return { kind, apiGroup };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: `Failed to parse YAML: ${message}` };
  }
}

/**
 * Execute kubectl apply.
 *
 * This is the core logic — framework wrappers (LangChain, Vercel AI, MCP) call this.
 * Admission enforcement (Kyverno, RBAC) is handled by the cluster, not this function.
 * Any rejection from the cluster surfaces as a non-zero kubectl exit and is returned
 * to the caller as-is.
 *
 * @param input - Validated input matching kubectlApplySchema
 * @param options - Optional configuration (e.g., kubeconfig path)
 * @returns KubectlResult with output string and isError flag
 */
export async function kubectlApply(
  input: KubectlApplyInput,
  options?: { kubeconfig?: string }
): Promise<KubectlResult> {
  const tracer = getTracer();

  return tracer.startActiveSpan(
    "kubectl apply",
    { kind: SpanKind.CLIENT },
    async (span) => {
      try {
        // Step 1: Parse the YAML manifest to validate structure and extract metadata
        const metadata = parseManifestMetadata(input.manifest);

        if ("error" in metadata) {
          span.setAttribute("error.type", "YAMLParseError");
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: metadata.error,
          });
          return {
            output: `Failed to parse YAML manifest: ${metadata.error}`,
            isError: true,
          };
        }

        span.setAttribute("cluster_whisperer.k8s.resource_kind", metadata.kind);
        span.setAttribute("cluster_whisperer.k8s.api_group", metadata.apiGroup);

        // Step 2: Apply the manifest via kubectl apply -f - (stdin)
        // Kyverno and RBAC handle admission enforcement — any rejection surfaces
        // as a non-zero exit code with the webhook error message in stderr.
        const applyArgs = options?.kubeconfig
          ? ["--kubeconfig", options.kubeconfig, "apply", "-f", "-"]
          : ["apply", "-f", "-"];

        span.setAttribute("process.executable.name", "kubectl");
        span.setAttribute("process.command_args", [
          "kubectl",
          ...applyArgs,
        ]);

        const result = spawnSync("kubectl", applyArgs, {
          input: input.manifest,
          encoding: "utf-8",
          timeout: 30000,
        });

        if (result.error) {
          span.setAttribute("process.exit.code", -1);
          span.setAttribute("error.type", result.error.name);
          span.recordException(result.error);
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: result.error.message,
          });
          return {
            output: `Error executing kubectl apply: ${result.error.message}`,
            isError: true,
          };
        }

        span.setAttribute("process.exit.code", result.status ?? -1);

        if (result.status !== 0) {
          const errorMessage = result.stderr || "Unknown error";
          span.setAttribute("error.type", "KubectlError");
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: errorMessage,
          });
          return {
            output: `Error executing kubectl apply: ${errorMessage}`,
            isError: true,
          };
        }

        // Success
        span.setAttribute(
          "cluster_whisperer.k8s.output_size_bytes",
          Buffer.byteLength(result.stdout, "utf-8")
        );
        span.setStatus({ code: SpanStatusCode.OK });

        return {
          output: result.stdout,
          isError: false,
        };
      } finally {
        span.end();
      }
    }
  );
}
