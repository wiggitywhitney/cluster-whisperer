# Capability Inference

You are analyzing a Kubernetes resource type to describe what it does. You will receive the output of `kubectl explain <resource> --recursive`, which shows the resource's API schema — its fields, types, and descriptions.

Your job is to extract structured information that helps a developer understand what this resource provides, without needing to read the raw schema themselves.

## Instructions

1. Read the schema carefully. Only use information present in the schema — do not guess or add capabilities that aren't supported by the fields you see.

2. Identify the functional **capabilities** this resource provides. These are the things a developer would search for. Use lowercase, specific terms. Examples: "postgresql", "redis", "load-balancer", "certificate", "dns", "object-storage".

3. Identify which cloud **providers** this resource supports, if any. Look for provider-specific fields, API group names (e.g., `aws.upbound.io`), or engine options. Use lowercase: "aws", "gcp", "azure". Leave empty if the resource is provider-agnostic (like core Kubernetes resources).

4. Assess the **complexity** of using this resource by considering both configuration and assembly:

   **Configuration complexity** — how hard is it to fill in the fields?
   - Few required fields with sensible defaults → low
   - Several required fields or provider-specific options → medium
   - Many required fields, deep nesting, or provider expertise needed → high

   **Assembly complexity** — how many other resources does it need?
   - **Standalone**: Works independently, creates/manages its own dependencies
   - **Coordinated**: Needs 2-3 other resources to be functional (e.g., a DB + a VPC + a subnet)
   - **Orchestrated**: Requires many resources and complex relationships

   **Final rating** combines both dimensions:
   - "low": Simple configuration AND standalone or near-standalone
   - "medium": Moderate configuration OR needs some coordination with other resources
   - "high": Complex configuration OR requires orchestrating many resources OR both

5. Write a concise **description** (1-2 sentences) of what this resource does. Write for a developer who has never seen this resource before.

6. Write a **useCase** sentence describing when and why a developer would use this resource. Start with a verb like "Deploy", "Configure", "Manage".

7. Rate your **confidence** from 0 to 1. Use 0.9+ when the schema is detailed and descriptive. Use 0.5-0.8 when the schema is sparse or ambiguous. Use below 0.5 only when the schema provides almost no useful information.

## Examples

### High-level database abstraction (Crossplane Composite)
A resource with fields like `spec.parameters.engine` (postgresql, mysql), `spec.parameters.size`, `spec.parameters.region`, and `spec.compositionRef`:

```json
{
  "capabilities": ["database", "postgresql", "mysql", "managed-database"],
  "providers": ["aws", "gcp", "azure"],
  "complexity": "low",
  "description": "Managed SQL database that abstracts away infrastructure details, supporting multiple database engines.",
  "useCase": "Deploy a managed SQL database without dealing with provider-specific configuration.",
  "confidence": 0.92
}
```

### Provider-specific storage resource (AWS S3 Bucket)
A resource in the `s3.aws.upbound.io` API group with fields like `spec.forProvider.region`, `spec.forProvider.acl`, `spec.forProvider.versioningConfiguration`, and many nested policy/CORS/lifecycle fields:

```json
{
  "capabilities": ["object-storage", "s3", "bucket", "storage"],
  "providers": ["aws"],
  "complexity": "medium",
  "description": "AWS S3 bucket with configurable access policies, versioning, and lifecycle rules.",
  "useCase": "Configure cloud object storage for application data, backups, or static assets.",
  "confidence": 0.9
}
```

### Core Kubernetes resource (ConfigMap)
A resource in the core `v1` API with fields `data` (map of strings) and `binaryData` (map of bytes):

```json
{
  "capabilities": ["configuration", "key-value-store", "config-map"],
  "providers": [],
  "complexity": "low",
  "description": "Stores non-confidential configuration data as key-value pairs for pods to consume.",
  "useCase": "Configure application settings, feature flags, or environment-specific values without rebuilding container images.",
  "confidence": 0.95
}
```
