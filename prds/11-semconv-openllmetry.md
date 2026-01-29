# PRD #11: Semconv Compliance + OpenLLMetry Integration

**Status**: In Progress
**Created**: 2026-01-28
**GitHub Issue**: [#11](https://github.com/wiggitywhitney/cluster-whisperer/issues/11)

---

## Problem Statement

Our current OpenTelemetry implementation (PRD #6) uses a hybrid approach with both Viktor's custom attributes and some OTel semantic conventions. This causes several issues:

1. **Missing required attributes**: We don't set `gen_ai.operation.name` (required by semconv)
2. **Viktor's custom attributes don't power Datadog features**: Attributes like `gen_ai.tool.input`, `gen_ai.tool.duration_ms`, and `k8s.*` are not recognized by Datadog LLM Observability
3. **No LLM call instrumentation**: cluster-whisperer uses LangChain → Anthropic, but we don't trace these calls
4. **Duplicate data**: Viktor's attributes duplicate semconv attributes (e.g., `gen_ai.tool.input` vs `gen_ai.tool.call.arguments`)

## Solution

### Part A: Full Semconv Compliance

Remove Viktor's custom attributes and add missing semconv attributes to achieve full OTel GenAI semantic convention compliance.

### Part B: OpenLLMetry Integration

Add `@traceloop/node-server-sdk` to auto-instrument LangChain → Anthropic LLM calls, creating complete end-to-end traces.

---

## Success Criteria

- [ ] All MCP tool spans have required semconv attributes
- [ ] Viktor's custom attributes removed (except pragmatic exceptions noted below)
- [ ] LLM calls create spans with token usage and model info
- [ ] Traces visible in **Datadog APM** with complete trace hierarchy
- [ ] Traces visible in **Datadog LLM Observability** with full feature support:
  - Token usage dashboards populated
  - Model/provider grouping functional
  - Cost analysis features available
- [ ] Documentation updated

## Milestones

- [x] **M1**: Semconv Compliance for MCP Tool Spans
  - Review `docs/opentelemetry-research.md` Section 10 (Semconv Gap Analysis)
  - Add `gen_ai.operation.name: "execute_tool"` (required)
  - Add `gen_ai.tool.type: "function"` (recommended)
  - Add `gen_ai.tool.call.id` with unique identifier (recommended)
  - Remove `gen_ai.tool.input` (duplicate of `gen_ai.tool.call.arguments`)
  - Remove `gen_ai.tool.duration_ms` (span timing handles this)
  - Remove `gen_ai.tool.success` (span status handles this)
  - Update `docs/opentelemetry.md` with new attribute list

- [x] **M2**: Semconv Compliance for kubectl Spans
  - Review `docs/opentelemetry-research.md` Section 10 (Semconv Gap Analysis)
  - Remove `k8s.client` (redundant with `process.executable.name`)
  - Remove `k8s.operation` (captured in span name)
  - Remove `k8s.resource` (captured in span name)
  - Remove `k8s.args` (redundant with `process.command_args`)
  - Remove `k8s.duration_ms` (span timing handles this)
  - **Keep** `k8s.namespace` (no semconv equivalent, useful for filtering)
  - **Keep** `k8s.output_size_bytes` (useful for debugging large responses)
  - Update `docs/opentelemetry.md` with new attribute list

- [ ] **M3**: OpenLLMetry Integration
  - Review `docs/opentelemetry-research.md` Section 7 (OpenLLMetry)
  - Install `@traceloop/node-server-sdk`
  - Initialize OpenLLMetry in tracing setup
  - Verify LangChain → Anthropic calls create spans
  - Verify token usage attributes captured
  - Test complete trace hierarchy: user → LLM → tool → kubectl

- [ ] **M4**: Datadog Verification (APM + LLM Observability)
  - Review `docs/opentelemetry-research.md` Section 9 (Datadog GenAI Semantic Conventions)
  - Deploy to Spider Rainbows cluster with Datadog Agent
  - Verify traces appear in **Datadog APM** with complete trace hierarchy
  - Verify traces appear in **Datadog LLM Observability**:
    - Token usage dashboards show input/output tokens
    - Model/provider grouping works correctly
    - Cost analysis features are available
  - Document any Datadog-specific configuration needed

---

## Technical Approach

### MCP Tool Span Attributes (After M1)

| Attribute | Value | Note |
|-----------|-------|------|
| `gen_ai.operation.name` | `"execute_tool"` | Required, was missing |
| `gen_ai.tool.name` | `"kubectl_get"` etc. | Already present |
| `gen_ai.tool.type` | `"function"` | New, recommended |
| `gen_ai.tool.call.id` | UUID | New, recommended |
| `gen_ai.tool.call.arguments` | JSON string | Already present |

### kubectl Span Attributes (After M2)

| Attribute | Value | Note |
|-----------|-------|------|
| `process.executable.name` | `"kubectl"` | Keep |
| `process.command_args` | `["kubectl", ...]` | Keep |
| `process.exit.code` | `0` or error code | Keep |
| `error.type` | Error class name | Keep (when error) |
| `k8s.namespace` | `"default"` etc. | Keep (pragmatic) |
| `k8s.output_size_bytes` | byte count | Keep (pragmatic) |

### OpenLLMetry Setup (M3)

```typescript
import * as traceloop from "@traceloop/node-server-sdk";

// Initialize before LangChain usage
traceloop.initialize({
  appName: "cluster-whisperer",
  disableBatch: process.env.NODE_ENV === "development",
});
```

### Trace Hierarchy (After M3)

```
LLM chat (from OpenLLMetry)
  ├── gen_ai.request.model: "claude-3-5-sonnet-20241022"
  ├── gen_ai.provider.name: "anthropic"
  ├── gen_ai.usage.input_tokens: 150
  └── gen_ai.usage.output_tokens: 200

  └── execute_tool kubectl_get (MCP tool span)
        ├── gen_ai.operation.name: "execute_tool"
        ├── gen_ai.tool.name: "kubectl_get"
        ├── gen_ai.tool.type: "function"
        └── gen_ai.tool.call.id: "uuid-123"

        └── kubectl get pods (kubectl span)
              ├── process.executable.name: "kubectl"
              ├── process.command_args: ["kubectl", "get", "pods"]
              ├── process.exit.code: 0
              └── k8s.namespace: "default"
```

---

## Design Decisions

### 2026-01-28: Full Semconv over Hybrid

**Decision**: Remove Viktor's custom attributes entirely, embrace full semconv.

**Rationale**:
- Viktor's attributes were useful for KubeCon comparison queries, but the demo benefit doesn't outweigh the maintenance cost
- Datadog LLM Observability only recognizes semconv attributes
- Single source of truth is easier to maintain and understand
- Span timing already captures duration; span status already captures success/failure

### 2026-01-28: Pragmatic Exceptions

**Decision**: Keep `k8s.namespace` and `k8s.output_size_bytes` as custom attributes.

**Rationale**:
- `k8s.namespace` has no semconv equivalent and is essential for Kubernetes filtering
- `k8s.output_size_bytes` helps debug large responses without semconv alternative
- These two attributes add genuine value without duplicating semconv

### 2026-01-28: OpenLLMetry over Custom LLM Instrumentation

**Decision**: Use OpenLLMetry (`@traceloop/node-server-sdk`) for LLM instrumentation.

**Rationale**:
- LangChain's native OTel is Python-only
- OpenLLMetry handles Anthropic SDK instrumentation automatically
- Already follows OTel GenAI semantic conventions
- Active project with community support

### 2026-01-28: Omit gen_ai.tool.call.result

**Decision**: Do not add `gen_ai.tool.call.result` attribute to MCP tool spans.

**Rationale**:
- kubectl output can be very large (pod listings, describe output, logs)
- No Datadog LLM Observability feature depends on this attribute
- The child kubectl span already has `k8s.output_size_bytes` for debugging large responses
- Semconv marks it "recommended" not "required"
- Cost (bloated spans, potential sensitive data) outweighs benefit (debugging context available elsewhere)

---

## Reference Sources

- Research document: `docs/opentelemetry-research.md` (sections 7-10)
- OTel GenAI semconv: <https://opentelemetry.io/docs/specs/semconv/gen-ai/>
- Datadog LLM Observability: <https://docs.datadoghq.com/llm_observability/>
- OpenLLMetry: <https://github.com/traceloop/openllmetry>

## Dependencies

- PRD #6 (OpenTelemetry Instrumentation) - base implementation
- Spider Rainbows cluster - test environment
- Datadog Agent with OTLP receiver - for M4 verification

## Out of Scope

- Metrics (traces only for now)
- Prompt/completion content capture (privacy concern for demo)
- Custom GenAI semantic convention extensions

---

## Progress Log

### 2026-01-28: PRD Created

- Created GitHub issue #11
- Added sections 7-10 to `docs/opentelemetry-research.md`
- Documented semconv gap analysis
- Defined milestones for implementation

### 2026-01-28: M1 Complete - MCP Tool Spans Semconv Compliance

- Added `gen_ai.operation.name`, `gen_ai.tool.type`, `gen_ai.tool.call.id` to `tool-tracing.ts`
- Removed Viktor's attributes (`gen_ai.tool.input`, `gen_ai.tool.duration_ms`, `gen_ai.tool.success`)
- Updated `docs/opentelemetry.md` with new attribute list
- Verified traces appear in Datadog APM with proper hierarchy

### 2026-01-29: M2 Complete - kubectl Spans Semconv Compliance

- Removed Viktor's redundant attributes from `src/utils/kubectl.ts`:
  - `k8s.client` (redundant with `process.executable.name`)
  - `k8s.operation` (captured in span name)
  - `k8s.resource` (captured in span name)
  - `k8s.args` (redundant with `process.command_args`)
  - `k8s.duration_ms` (span timing handles this)
- Kept pragmatic custom attributes: `k8s.namespace`, `k8s.output_size_bytes`
- Updated `docs/opentelemetry.md` with new kubectl attribute list
- **Bug fix**: Added `withToolTracing()` to LangChain tools (`src/tools/langchain/index.ts`)
  - LangChain tools were missing tracing wrapper, causing orphaned kubectl spans
  - Now both MCP and LangChain tools create proper `execute_tool` parent spans
- Made `withToolTracing()` generic to support any return type (not just MCP responses)
- Verified parent-child span hierarchy in Datadog APM
