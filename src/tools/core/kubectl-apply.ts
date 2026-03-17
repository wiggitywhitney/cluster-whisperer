// ABOUTME: kubectl-apply core tool — deploys resources after validating against the capabilities catalog
// ABOUTME: Parses YAML to extract kind/apiGroup, queries vector DB for approval, then runs kubectl apply

/**
 * kubectl-apply core - Deploys Kubernetes resources with catalog validation
 *
 * This module adds a "write" tool to cluster-whisperer. Unlike the read-only
 * kubectl tools (get, describe, logs), this tool modifies the cluster by
 * applying resource manifests.
 *
 * Safety mechanism: Before applying, it validates the resource type against
 * the capabilities collection in the vector database. Only resource types that
 * have been synced (and therefore approved by the platform team) can be deployed.
 * This is tool-level enforcement — not a prompt-level guardrail that the LLM
 * could ignore.
 *
 * Flow:
 *   1. Parse YAML manifest → extract kind and apiGroup
 *   2. Query capabilities collection for this resource type (keywordSearch, no embeddings)
 *   3. If found → kubectl apply -f - (pipe manifest via stdin)
 *   4. If not found → return error to agent (tool rejects, not the prompt)
 */

import { z } from "zod";
import { spawnSync } from "child_process";
import { load as yamlLoad } from "js-yaml";
import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import type { VectorStore } from "../../vectorstore";
import type { KubectlResult } from "../../utils/kubectl";
import { getTracer } from "../../tracing";

/**
 * Input schema for kubectl apply.
 *
 * Takes a complete YAML manifest string. The tool parses it internally
 * to extract the resource type for catalog validation.
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
 * Explains the catalog validation so the agent understands why some
 * resources will be rejected. The agent should use vector_search first
 * to discover what resource types are available before attempting to apply.
 */
export const kubectlApplyDescription = `Deploy a Kubernetes resource by applying a YAML manifest.

IMPORTANT: This tool validates the resource type against the platform's approved catalog before applying. Only resource types that appear in the capabilities collection can be deployed. If a resource type is not in the catalog, the apply will be rejected.

Workflow:
1. Use vector_search to discover available resource types
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
 * Standard Kubernetes built-in API groups that are always rejected.
 *
 * The demo's message is "the platform team controls what's allowed." Standard
 * k8s resources (Deployment, Service, ConfigMap, etc.) can appear in the
 * capabilities catalog because the sync pipeline indexes all cluster CRDs —
 * but they must never be deployable through this tool.
 *
 * Only resources from custom API groups (e.g., *.acme.io, *.crossplane.io)
 * that the platform team has explicitly published to the catalog are allowed.
 */
const BUILT_IN_API_GROUPS = new Set([
  "",                                  // core: Pod, Service, ConfigMap, Secret
  "apps",                              // Deployment, StatefulSet, DaemonSet, ReplicaSet
  "batch",                             // Job, CronJob
  "autoscaling",                       // HorizontalPodAutoscaler
  "extensions",                        // (deprecated, but still seen)
  "policy",                            // PodDisruptionBudget
  "networking.k8s.io",                 // Ingress, NetworkPolicy
  "rbac.authorization.k8s.io",         // ClusterRole, RoleBinding
  "storage.k8s.io",                    // StorageClass, PersistentVolume
  "admissionregistration.k8s.io",      // MutatingWebhookConfiguration
  "apiextensions.k8s.io",              // CustomResourceDefinition
  "coordination.k8s.io",               // Lease
  "discovery.k8s.io",                  // EndpointSlice
  "events.k8s.io",                     // Event
  "flowcontrol.apiserver.k8s.io",      // FlowSchema
  "node.k8s.io",                       // RuntimeClass
  "scheduling.k8s.io",                 // PriorityClass
]);

/**
 * Parse a YAML manifest to extract the kind and apiGroup.
 *
 * The apiGroup is derived from the apiVersion field:
 * - "apps/v1" → apiGroup "apps"
 * - "acid.zalan.do/v1" → apiGroup "acid.zalan.do"
 * - "v1" → apiGroup "" (core API, no group)
 *
 * Multi-document YAML (separated by ---) is rejected. This tool only
 * supports single-resource manifests to prevent smuggling unapproved
 * resources past catalog validation.
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
 * Execute kubectl apply with catalog validation.
 *
 * This is the core logic — framework wrappers (LangChain, MCP) call this.
 * The VectorStore is injected for testability and backend-agnosticism.
 *
 * @param vectorStore - An initialized VectorStore instance for catalog queries
 * @param input - Validated input matching kubectlApplySchema
 * @param options - Optional configuration (e.g., kubeconfig path)
 * @returns KubectlResult with output string and isError flag
 */
export async function kubectlApply(
  vectorStore: VectorStore,
  input: KubectlApplyInput,
  options?: { kubeconfig?: string }
): Promise<KubectlResult> {
  const tracer = getTracer();

  return tracer.startActiveSpan(
    "kubectl apply",
    { kind: SpanKind.CLIENT },
    async (span) => {
      try {
        // Step 1: Parse the YAML manifest
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

        // Step 2a: Reject standard Kubernetes built-in resource types immediately.
        // These must never be deployable through this tool regardless of catalog
        // contents — only platform-published custom resources are allowed.
        if (BUILT_IN_API_GROUPS.has(metadata.apiGroup)) {
          const displayGroup = metadata.apiGroup || "core";
          const msg = `Resource type ${metadata.kind} (${displayGroup}) is a standard Kubernetes resource and cannot be deployed through this tool. Only platform-approved resource types from the capabilities catalog are allowed.`;
          span.setAttribute("error.type", "BuiltInResourceRejection");
          span.setStatus({ code: SpanStatusCode.ERROR, message: msg });
          return { output: msg, isError: true };
        }

        // Step 2b: Validate against the capabilities catalog
        let catalogResults;
        try {
          catalogResults = await vectorStore.keywordSearch(
            "capabilities",
            undefined,
            {
              where: { kind: metadata.kind, apiGroup: metadata.apiGroup },
              nResults: 1,
            }
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          span.setAttribute("error.type", "CatalogValidationError");
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message,
          });
          return {
            output: `Catalog validation failed: ${message}`,
            isError: true,
          };
        }

        span.setAttribute(
          "cluster_whisperer.catalog.approved",
          catalogResults.length > 0
        );

        if (catalogResults.length === 0) {
          const msg = `Resource type ${metadata.kind} (${metadata.apiGroup || "core"}) is not in the approved platform catalog. Cannot apply.`;
          span.setAttribute("error.type", "CatalogRejection");
          span.setStatus({ code: SpanStatusCode.ERROR, message: msg });
          return { output: msg, isError: true };
        }

        // Step 3: Apply the manifest via kubectl apply -f - (stdin)
        // Include --kubeconfig if specified (demo governance: agent has cluster access)
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
