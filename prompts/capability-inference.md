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

5. Write a concise **description** (1-2 sentences) of what this resource does. Write for a developer who has never seen this resource before. If the schema includes organizational context — team names, application names, project names, or people — preserve those details in the description. This context is critical for distinguishing similar resources from different teams.

6. Write a **useCase** sentence describing when and why a developer would use this resource. Start with a verb like "Deploy", "Configure", "Manage".

7. Write a minimal **exampleYaml** manifest showing a valid resource with apiVersion, kind, metadata.name, and the key spec fields filled in with realistic example values. Keep it short — only include fields that a developer would typically set. Use YAML format (not JSON).

8. Rate your **confidence** from 0 to 1. Use 0.9+ when the schema is detailed and descriptive. Use 0.5-0.8 when the schema is sparse or ambiguous. Use below 0.5 only when the schema provides almost no useful information.

## Examples

### Team-specific platform resource (Crossplane Composite with organizational context)
A resource in the `payments.acme.io` API group. The spec description says "Platform-provided PostgreSQL database provisioned by the Acme platform team for the Payments division. Used by Sarah Chen's Transaction Processing App." Fields include `spec.engine` (postgresql), `spec.storageGB`, `spec.instanceSize`, `spec.highAvailability`:

```json
{
  "capabilities": ["database", "postgresql", "managed-database", "backup", "high-availability"],
  "providers": [],
  "complexity": "low",
  "description": "Platform-provided PostgreSQL database for the Payments division, used by Sarah Chen's Transaction Processing App. Abstracts away provider details — developers configure engine, size, and storage.",
  "useCase": "Deploy a managed PostgreSQL database for the Payments division's transaction processing workflows.",
  "exampleYaml": "apiVersion: payments.acme.io/v1alpha1\nkind: ManagedService\nmetadata:\n  name: transaction-db\nspec:\n  engine: postgresql\n  storageGB: 100\n  instanceSize: medium",
  "confidence": 0.93
}
```

### Team-specific platform resource (different team, same kind)
A resource in the `data.acme.io` API group. The spec description says "Platform-provided PostgreSQL database provisioned by the Acme platform team for the Data division. Used by Rachel Torres's Data Lake Manager." Fields include `spec.engine` (postgresql), `spec.storageGB`, `spec.instanceSize`:

```json
{
  "capabilities": ["database", "postgresql", "managed-database", "backup", "high-availability"],
  "providers": [],
  "complexity": "low",
  "description": "Platform-provided PostgreSQL database for the Data division, used by Rachel Torres's Data Lake Manager. Developers configure engine, size, and storage while the platform handles provisioning.",
  "useCase": "Deploy a managed PostgreSQL database for the Data division's data lake workflows.",
  "exampleYaml": "apiVersion: data.acme.io/v1alpha1\nkind: ManagedService\nmetadata:\n  name: data-lake-db\nspec:\n  engine: postgresql\n  storageGB: 500\n  instanceSize: large",
  "confidence": 0.93
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
  "exampleYaml": "apiVersion: s3.aws.upbound.io/v1beta1\nkind: Bucket\nmetadata:\n  name: my-bucket\nspec:\n  forProvider:\n    region: us-east-1",
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
  "exampleYaml": "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: my-config\ndata:\n  DATABASE_URL: postgresql://localhost:5432/mydb",
  "confidence": 0.95
}
```
