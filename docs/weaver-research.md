# OpenTelemetry Weaver Research

**PRD**: #19 - Weaver Schema Validation
**Date**: 2026-02-05
**Status**: Active Research Document

---

## Table of Contents

1. [Why Weaver is Now Applicable](#1-why-weaver-is-now-applicable)
2. [Attribute Inventory from Code](#2-attribute-inventory-from-code)
3. [Attribute Categorization](#3-attribute-categorization)
4. [Weaver CLI Workflow](#4-weaver-cli-workflow)
5. [Registry Structure Preview](#5-registry-structure-preview)

---

## 1. Why Weaver is Now Applicable

### Previous Assessment (PRD #6, January 2026)

`docs/opentelemetry-research.md` Section 3 concluded "Weaver is NOT Applicable" because:

> 1. **Constants already exist** - The `@opentelemetry/semantic-conventions` npm package provides all TypeScript constants we need.
> 2. **Solves enterprise-scale problems** - Designed for organizations managing custom semantic conventions across many teams/services.
> 3. **No custom schemas** - We follow standard conventions.

### Changed Circumstances

**This assessment is now outdated.** Since PRD #6, cluster-whisperer has evolved:

| Then (PRD #6) | Now (PRD #19) |
|---------------|---------------|
| Zero custom attributes | 5 custom attributes (`service.operation`, `user.question`, `mcp.tool.name`, `k8s.namespace`, `k8s.output_size_bytes`) |
| No documented conventions | 364-line `docs/tracing-conventions.md` with 20+ attributes across 4 span types |
| Simple kubectl wrapper | Full MCP server with CLI and MCP modes, each with distinct attribute sets |
| Single entry point | Two entry points (`withAgentTracing`, `withMcpRequestTracing`) with different GenAI semconv requirements |

### Why Weaver Now Adds Value

1. **Custom attributes need typing**: Our `k8s.*` and `mcp.*` attributes have no semconv package. Weaver provides schema-driven type definitions.

2. **Drift risk is real**: `docs/tracing-conventions.md` documents attributes that could diverge from code without detection. Weaver validates the schema.

3. **OTel reference validation**: We claim to use `gen_ai.*` and `process.*` semconvs. Weaver can verify these references resolve correctly.

4. **Proven lightweight pattern**: commit-story-v2 demonstrated that Weaver works for small projects with minimal overhead (3 files, ~150 lines of YAML).

### What We're NOT Using Weaver For

- **Code generation**: Weaver generates Go/Rust/Markdown, not TypeScript. We continue using manual instrumentation.
- **Live validation**: CI integration is deferred until schema is stable.
- **Enterprise governance**: We're not managing cross-team conventions.

**Our use case**: Schema as documentation + validation that our custom attributes are properly typed and OTel references resolve correctly.

---

## 2. Attribute Inventory from Code

This inventory was extracted from actual source files, not documentation.

### Root Span Attributes

**Source**: `src/tracing/context-bridge.ts`

#### CLI Mode: `withAgentTracing()` (lines 142-197)

| Attribute | Value/Source | Content-Gated |
|-----------|--------------|---------------|
| `cluster_whisperer.service.operation` | `"investigate"` | No |
| `traceloop.span.kind` | `"workflow"` | No |
| `traceloop.entity.name` | `"investigate"` | No |
| `cluster_whisperer.user.question` | User input | Yes |
| `traceloop.entity.input` | User input | Yes |
| `traceloop.entity.output` | Final answer | Yes |

#### MCP Mode: `withMcpRequestTracing()` (lines 234-320)

| Attribute | Value/Source | Content-Gated |
|-----------|--------------|---------------|
| `cluster_whisperer.service.operation` | Tool name | No |
| `traceloop.span.kind` | `"workflow"` | No |
| `traceloop.entity.name` | Tool name | No |
| `cluster_whisperer.mcp.tool.name` | Tool name | No |
| `gen_ai.operation.name` | `"execute_tool"` | No |
| `gen_ai.tool.name` | Tool name | No |
| `gen_ai.tool.type` | `"function"` | No |
| `gen_ai.tool.call.id` | `randomUUID()` | No |
| `traceloop.entity.input` | JSON input | Yes |
| `traceloop.entity.output` | Result content | Yes |

### Subprocess Span Attributes

**Source**: `src/utils/kubectl.ts` (lines 167-279)

| Attribute | When Set | Example Value |
|-----------|----------|---------------|
| `process.executable.name` | Always | `"kubectl"` |
| `process.command_args` | Always | `["kubectl", "get", "pods", "-n", "default"]` |
| `process.exit.code` | Always | `0`, `-1` |
| `error.type` | On error | `"KubectlError"`, `"Error"` |
| `cluster_whisperer.k8s.namespace` | If `-n` flag present | `"default"` |
| `cluster_whisperer.k8s.output_size_bytes` | On success | `1234` |

### Tool Span Attributes

**Source**: `src/tracing/tool-tracing.ts` (via OpenLLMetry `withTool()`)

| Attribute | Set By | Value |
|-----------|--------|-------|
| `traceloop.span.kind` | OpenLLMetry | `"tool"` |
| `traceloop.entity.name` | OpenLLMetry | Tool name from config |

---

## 3. Attribute Categorization

### Category 1: OTel Semantic Convention References

These attributes have official definitions in the OTel semantic conventions registry. In Weaver, we use `ref:` to import them.

| Attribute | Semconv Namespace | Version |
|-----------|-------------------|---------|
| `gen_ai.operation.name` | GenAI | v1.37.0 |
| `gen_ai.tool.name` | GenAI | v1.37.0 |
| `gen_ai.tool.type` | GenAI | v1.37.0 |
| `gen_ai.tool.call.id` | GenAI | v1.37.0 |
| `process.executable.name` | Process | v1.37.0 |
| `process.command_args` | Process | v1.37.0 |
| `process.exit.code` | Process | v1.37.0 |
| `error.type` | Error | v1.37.0 |

**Weaver treatment**: Reference via `ref: gen_ai.operation.name` etc.

### Category 2: OpenLLMetry Conventions

These attributes are defined by OpenLLMetry/Traceloop, not official OTel semconvs. They're vendor-specific but part of our instrumentation ecosystem.

| Attribute | Description |
|-----------|-------------|
| `traceloop.span.kind` | Span category: `"workflow"`, `"tool"`, `"task"` |
| `traceloop.entity.name` | Entity identifier within the span kind |
| `traceloop.entity.input` | Input content (content-gated) |
| `traceloop.entity.output` | Output content (content-gated) |

**Weaver treatment**: Define as custom attributes with `traceloop.*` namespace. Note they're OpenLLMetry conventions in the `brief` field.

### Category 3: Custom Attributes (No Standard Equivalent)

These attributes are cluster-whisperer specific with no semconv or vendor convention. They use the `cluster_whisperer.*` namespace to avoid conflicts with future OTel conventions.

| Attribute | Type | Description | Rationale |
|-----------|------|-------------|-----------|
| `cluster_whisperer.service.operation` | string | Operation name (`"investigate"`, tool name) | Describes the high-level operation type |
| `cluster_whisperer.user.question` | string | User's natural language question | CLI-specific; no GenAI semconv for user input in non-chat contexts |
| `cluster_whisperer.mcp.tool.name` | string | MCP tool identifier | MCP has no semconv yet; provides MCP-specific identification |
| `cluster_whisperer.k8s.namespace` | string | Kubernetes namespace from `-n` flag | No process semconv for command-specific metadata |
| `cluster_whisperer.k8s.output_size_bytes` | int | Byte length of kubectl stdout | Useful for debugging large responses; no output size semconv |

**Weaver treatment**: Define as custom attributes with `cluster_whisperer.*` namespace. Code already uses these namespaced names.

### Summary by Category

| Category | Count | Weaver Treatment |
|----------|-------|------------------|
| OTel References | 8 | `ref:` imports |
| OpenLLMetry | 4 | Custom definitions |
| Custom | 5 | Custom definitions |
| **Total** | **17** | |

---

## 4. Weaver CLI Workflow

### Installation

Weaver requires Rust. Install via cargo:

```bash
# Install Rust if not present
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# Install Weaver
cargo install weaver
```

### Core Commands

| Command | Purpose |
|---------|---------|
| `weaver registry check` | Validate registry structure and references |
| `weaver registry resolve` | Expand all references to produce flat output |

### Validation Workflow

```bash
# 1. Check registry for errors
weaver registry check telemetry/registry

# 2. Resolve references and output to JSON
weaver registry resolve telemetry/registry -f json -o telemetry/registry/resolved.json
```

### Expected Output

**`weaver registry check`** (success):
```
Registry check completed successfully.
```

**`weaver registry resolve`** produces a flat JSON/YAML with all references expanded and attributes fully defined.

---

## 5. Registry Structure Preview

Based on the commit-story-v2 pattern, cluster-whisperer's registry will be:

```text
telemetry/registry/
├── registry_manifest.yaml    # Metadata + OTel v1.37.0 dependency
├── attributes.yaml           # All attribute group definitions
└── resolved.json             # Output from weaver registry resolve
```

### Attribute Groups

| Group ID | Purpose |
|----------|---------|
| `registry.cluster_whisperer.root` | Root span attributes (both modes) |
| `registry.cluster_whisperer.mcp` | MCP-specific attributes (GenAI refs) |
| `registry.cluster_whisperer.subprocess` | kubectl subprocess attributes (Process refs) |
| `registry.cluster_whisperer.openllmetry` | OpenLLMetry `traceloop.*` attributes |

### registry_manifest.yaml (Preview)

```yaml
name: cluster_whisperer
description: OpenTelemetry semantic conventions for cluster-whisperer
semconv_version: 0.1.0

dependencies:
  - name: otel
    registry_path: https://github.com/open-telemetry/semantic-conventions/archive/refs/tags/v1.37.0.zip[model]
```

### attributes.yaml Structure (Preview)

```yaml
groups:
  # Root span attributes
  - id: registry.cluster_whisperer.root
    type: attribute_group
    brief: Attributes for root investigation/tool spans
    attributes:
      - id: cluster_whisperer.service.operation
        type: string
        stability: development
        brief: The high-level operation type
        examples: ["investigate", "kubectl_get"]

      - id: cluster_whisperer.user.question
        type: string
        stability: development
        brief: User's natural language question (content-gated)
        examples: ["Find the broken pod and tell me why it's failing"]

  # MCP-specific attributes with GenAI refs
  - id: registry.cluster_whisperer.mcp
    type: attribute_group
    brief: MCP tool execution attributes
    attributes:
      - id: cluster_whisperer.mcp.tool.name
        type: string
        stability: development
        brief: The MCP tool name
        examples: ["kubectl_get", "kubectl_describe", "kubectl_logs"]

      - ref: gen_ai.operation.name
      - ref: gen_ai.tool.name
      - ref: gen_ai.tool.type
      - ref: gen_ai.tool.call.id

  # Subprocess attributes with Process refs
  - id: registry.cluster_whisperer.subprocess
    type: attribute_group
    brief: kubectl subprocess execution attributes
    attributes:
      - ref: process.executable.name
      - ref: process.command_args
      - ref: process.exit.code
      - ref: error.type

      - id: cluster_whisperer.k8s.namespace
        type: string
        stability: development
        brief: Kubernetes namespace from -n flag
        examples: ["default", "kube-system"]

      - id: cluster_whisperer.k8s.output_size_bytes
        type: int
        stability: development
        brief: Byte length of kubectl stdout
        examples: [1234, 5678]

  # OpenLLMetry attributes
  - id: registry.cluster_whisperer.openllmetry
    type: attribute_group
    brief: OpenLLMetry/Traceloop attributes for LLM observability
    attributes:
      - id: traceloop.span.kind
        type:
          members:
            - id: workflow
              value: workflow
              brief: Top-level workflow span
            - id: tool
              value: tool
              brief: Tool execution span
            - id: task
              value: task
              brief: Task execution span
        stability: development
        brief: OpenLLMetry span category

      - id: traceloop.entity.name
        type: string
        stability: development
        brief: Entity identifier within the span kind
        examples: ["investigate", "kubectl_get"]

      - id: traceloop.entity.input
        type: string
        stability: development
        brief: Input content (content-gated)
        note: Only captured when OTEL_TRACE_CONTENT_ENABLED=true

      - id: traceloop.entity.output
        type: string
        stability: development
        brief: Output content (content-gated)
        note: Only captured when OTEL_TRACE_CONTENT_ENABLED=true
```

---

## References

- [OpenTelemetry Weaver](https://github.com/open-telemetry/weaver)
- [OTel Semantic Conventions v1.37.0](https://github.com/open-telemetry/semantic-conventions/tree/v1.37.0)
- commit-story-v2 implementation: (external project reference - see local clone)
- Existing conventions: `docs/tracing-conventions.md`
- Previous assessment: `docs/opentelemetry-research.md` Section 3
