# PRD #23: Add GenAI Semantic Conventions to Tool Spans

**Status**: In Progress
**Created**: 2026-02-09
**GitHub Issue**: [#23](https://github.com/wiggitywhitney/cluster-whisperer/issues/23)

---

## Problem Statement

Tool call spans (`kubectl_get.tool`, `kubectl_describe.tool`, `kubectl_logs.tool`) are invisible in Datadog's LLM Observability view. The spans exist in the trace data with correct parent-child relationships, but Datadog's LLM Observability view only renders spans with OTel `gen_ai.*` semantic convention attributes.

Our tool spans currently only have OpenLLMetry's `traceloop.*` attributes (set by `withTool()`), not the `gen_ai.*` attributes that Datadog expects for tool execution spans. This regressed when PRD-11 M3 replaced manual `gen_ai.*` attribute setting with OpenLLMetry's `withTool()` wrapper, which hasn't adopted the OTel GenAI semantic conventions for tool spans yet.

**Before PRD-11 M3** (visible in LLM Observability):
```
Tool span attributes:
  gen_ai.operation.name: "execute_tool"
  gen_ai.tool.name: "kubectl_get"
  gen_ai.tool.type: "function"
  gen_ai.tool.call.id: "<uuid>"
```

**After PRD-11 M3** (invisible in LLM Observability):
```
Tool span attributes:
  traceloop.span.kind: "tool"
  traceloop.entity.name: "kubectl_get"
```

This matters for the KubeCon demo — the audience needs to see the complete investigation chain (LLM reasoning + tool calls + results) in one trace view.

## Root Cause

OpenLLMetry's `withTool()` wrapper predates OTel's GenAI semantic conventions and uses Traceloop's own `traceloop.*` attribute namespace. OTel has since standardized the [`execute_tool` span spec](https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-spans/) with `gen_ai.*` attributes. OpenLLMetry hasn't migrated `withTool()` to use these yet:

- [OpenLLMetry issue #3515](https://github.com/traceloop/openllmetry/issues/3515) — open, covers `gen_ai.prompt`/`gen_ai.completion` deprecation
- [OpenLLMetry issue #3460](https://github.com/traceloop/openllmetry/issues/3460) — open RFC for agent observability semconv including `gen_ai.tool.execute`

Until OpenLLMetry closes this gap upstream, we need to add the `gen_ai.*` attributes ourselves.

## Solution

Add OTel GenAI semantic convention attributes to the existing tool spans created by `withToolTracing()`. No new spans, no context propagation changes — just attributes added to the span that OpenLLMetry's `withTool()` already creates.

The approach: after `withTool()` creates the span, retrieve it from the active context and set the `gen_ai.*` attributes on it. This gives us both sets of attributes (OpenLLMetry's `traceloop.*` for ecosystem compatibility + OTel's `gen_ai.*` for Datadog LLM Observability).

**Target span attributes (both namespaces):**
```
# OTel GenAI semantic conventions (NEW — for Datadog LLM Observability)
gen_ai.operation.name: "execute_tool"
gen_ai.tool.name: "kubectl_get"
gen_ai.tool.type: "function"
gen_ai.tool.call.id: "<uuid>"

# OpenLLMetry conventions (EXISTING — set by withTool())
traceloop.span.kind: "tool"
traceloop.entity.name: "kubectl_get"
```

### Files to Change

1. **`src/tracing/tool-tracing.ts`** — Add `gen_ai.*` attributes inside `withToolTracing()` after `withTool()` creates the span
2. **`telemetry/registry/attributes.yaml`** — Add tool span attribute group referencing `gen_ai.tool.*` semconvs
3. **`telemetry/registry/resolved.json`** — Regenerate with `npm run telemetry:resolve`

### OTel GenAI Execute Tool Spec Reference

From [OTel GenAI Spans - Execute Tool](https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-spans/):

| Attribute | Requirement | Value |
|-----------|-------------|-------|
| `gen_ai.operation.name` | Required | `"execute_tool"` |
| `gen_ai.tool.name` | Recommended | Tool name (e.g., `"kubectl_get"`) |
| `gen_ai.tool.type` | Recommended | `"function"` |
| `gen_ai.tool.call.id` | Recommended | UUID |
| `gen_ai.tool.description` | Recommended | Tool description |
| `gen_ai.tool.call.arguments` | Opt-In | Tool input (content-gated) |
| `gen_ai.tool.call.result` | Opt-In | Tool output (content-gated) |

We will implement Required + Recommended attributes. Opt-in attributes (`arguments`, `result`) are deferred — the existing `traceloop.entity.input`/`traceloop.entity.output` already capture this content.

---

## Milestones

### M1: Add GenAI attributes to tool spans

**Goal**: Tool spans have both `gen_ai.*` and `traceloop.*` attributes.

**Changes**:
- Modify `withToolTracing()` in `src/tracing/tool-tracing.ts` to retrieve the active span after `withTool()` creates it, then set `gen_ai.operation.name`, `gen_ai.tool.name`, `gen_ai.tool.type`, `gen_ai.tool.call.id` on it
- Import `trace` from `@opentelemetry/api` and `randomUUID` from `crypto`

**Validation**:
- Run CLI with console exporter: `OTEL_TRACING_ENABLED=true vals exec -i -f .vals.yaml -- node dist/index.js "Find the broken pod and tell me why it's failing"`
- Verify tool spans in console output contain both `gen_ai.*` and `traceloop.*` attributes

### M2: Update Weaver schema

**Goal**: Attribute registry reflects the new tool span attributes.

**Changes**:
- Add a tool span attribute group to `telemetry/registry/attributes.yaml` with refs to `gen_ai.operation.name`, `gen_ai.tool.name`, `gen_ai.tool.type`, `gen_ai.tool.call.id`
- Regenerate `telemetry/registry/resolved.json` with `npm run telemetry:resolve`
- Validate with `npm run telemetry:check`

### M3: Verify in Datadog LLM Observability — CLI mode

**Goal**: Tool spans are visible in Datadog's LLM Observability trace view when run from CLI.

**Steps**:
1. Build: `npm run build`
2. Run CLI with OTLP export:
   ```bash
   OTEL_TRACING_ENABLED=true \
   OTEL_EXPORTER_TYPE=otlp \
   OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 \
   OTEL_CAPTURE_AI_PAYLOADS=true \
   vals exec -i -f .vals.yaml -- node dist/index.js "Find the broken pod and tell me why it's failing"
   ```
3. Open Datadog APM traces: search for `service:cluster-whisperer`
4. Open the trace in LLM Observability view (the "LLM" badge view)
5. Verify `kubectl_get.tool`, `kubectl_describe.tool` spans appear in the span list alongside `chat.anthropic`/`anthropic.chat` spans

**Success criteria**: Tool spans visible in LLM Observability view with `gen_ai.operation.name: "execute_tool"` attribute.

### M4: Verify in Datadog LLM Observability — MCP mode

**Goal**: Tool spans are visible in Datadog's LLM Observability trace view when run via MCP (Claude Code).

**Steps**:
1. Ensure `.mcp.json` has tracing environment variables enabled (OTEL_TRACING_ENABLED, OTEL_EXPORTER_TYPE=otlp, etc.)
2. Restart Claude Code to pick up `.mcp.json` changes
3. Call the investigate tool via Claude Code (use the cluster-whisperer MCP server)
4. Open the resulting trace in Datadog LLM Observability view
5. Verify tool spans appear in the span list

**Success criteria**: Same as M3 — tool spans visible in LLM Observability view for MCP-initiated traces.

---

## Progress Log

### 2026-02-10: M1 complete — GenAI attributes added to tool spans
- Modified `withToolTracing()` in `src/tracing/tool-tracing.ts` to set `gen_ai.operation.name`, `gen_ai.tool.name`, `gen_ai.tool.type`, `gen_ai.tool.call.id` on the active span after `withTool()` creates it
- Validated with console exporter: all 5 tool spans (kubectl_get x2, kubectl_describe x3) contain both `gen_ai.*` and `traceloop.*` attributes
- Build passes cleanly
