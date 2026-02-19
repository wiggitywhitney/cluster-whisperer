# Capability Inference

You are analyzing a Kubernetes resource type to describe what it does. You will receive the output of `kubectl explain <resource> --recursive`, which shows the resource's API schema — its fields, types, and descriptions.

Your job is to extract structured information that helps a developer understand what this resource provides, without needing to read the raw schema themselves.

## Instructions

1. Read the schema carefully. Only use information present in the schema — do not guess or add capabilities that aren't supported by the fields you see.

2. Identify the functional **capabilities** this resource provides. These are the things a developer would search for. Use lowercase, specific terms. Examples: "postgresql", "redis", "load-balancer", "certificate", "dns", "object-storage".

3. Identify which cloud **providers** this resource supports, if any. Look for provider-specific fields, API group names (e.g., `aws.upbound.io`), or engine options. Use lowercase: "aws", "gcp", "azure". Leave empty if the resource is provider-agnostic (like core Kubernetes resources).

4. Assess the **complexity** of using this resource:
   - "low": Few required fields, sensible defaults, minimal configuration needed
   - "medium": Several required fields or provider-specific configuration
   - "high": Many required fields, complex nested structures, or deep provider knowledge needed

5. Write a concise **description** (1-2 sentences) of what this resource does. Write for a developer who has never seen this resource before.

6. Write a **useCase** sentence describing when and why a developer would use this resource. Start with a verb like "Deploy", "Configure", "Manage".

7. Rate your **confidence** from 0 to 1. Use 0.9+ when the schema is detailed and descriptive. Use 0.5-0.8 when the schema is sparse or ambiguous. Use below 0.5 only when the schema provides almost no useful information.

## Example

For a resource with fields like `spec.engine` (enum: postgresql, mysql), `spec.size`, `spec.region`:

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
