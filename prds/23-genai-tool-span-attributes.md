# PRD #23: Add GenAI Semantic Conventions to Tool and LLM Spans

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
gen_ai.tool.description: "List Kubernetes resources in TABLE FORMAT..."
gen_ai.tool.call.arguments: '{"resource":"pods","namespace":"all"}'   # content-gated
gen_ai.tool.call.result: "NAME  READY  STATUS..."                     # content-gated

# OpenLLMetry conventions (EXISTING — set by withTool())
traceloop.span.kind: "tool"
traceloop.entity.name: "kubectl_get"
```

**Datadog LLM Observability UI mapping:**

| `gen_ai.*` Attribute | Datadog UI Element |
|---|---|
| `gen_ai.operation.name` | Span type badge ("Tool") |
| `gen_ai.tool.name` | Span name in list |
| `gen_ai.tool.call.id` | Metadata: `tool_id` |
| `gen_ai.tool.type` | Metadata: `tool_type` |
| `gen_ai.tool.description` | Metadata: `tool_description` |
| `gen_ai.tool.call.arguments` | Input panel content |
| `gen_ai.tool.call.result` | Output panel content |

Note: Datadog's LLM Observability view only reads `gen_ai.*` attributes. The `traceloop.entity.input`/`traceloop.entity.output` values are invisible in LLM Observability (they remain visible in APM).

### LLM Span Enhancement: Tool Definitions

In addition to tool span attributes, LLM/chat spans should include `gen_ai.tool.definitions` — a JSON array describing the available tools. Datadog maps this to `meta.tool_definitions` in the LLM Observability view.

```
# On chat.anthropic / anthropic.chat spans:
gen_ai.tool.definitions: '[{"name":"kubectl_get","description":"...","parameters":{...}}, ...]'
```

This tells the observer which tools the LLM had available during each reasoning step.

### Files to Change

**Tool spans (gen_ai.tool.* on execute_tool spans):**
1. **`src/tracing/tool-tracing.ts`** — Add all `gen_ai.*` attributes inside `withToolTracing()` after `withTool()` creates the span. Content attributes (`arguments`, `result`) gated behind `OTEL_CAPTURE_AI_PAYLOADS`. Accept `description` as a new parameter.
2. **`src/tools/langchain/index.ts`** — Pass tool descriptions to `withToolTracing()` calls
   - Note: `src/tools/mcp/index.ts` does not use `withToolTracing()` — it wraps the LangGraph agent via `invokeInvestigator()`, not individual tools

**LLM spans (gen_ai.tool.definitions on chat spans):**
4. **Investigation needed** — The `chat.anthropic`/`anthropic.chat` spans are created by OpenLLMetry's auto-instrumentation of the Anthropic SDK. We need to determine whether OpenLLMetry already sets `gen_ai.tool.definitions`, or if we need a custom SpanProcessor to inject it. Check the actual span attributes in Datadog/console output first.

**Schema:**
5. **`telemetry/registry/attributes.yaml`** — Add tool span attribute group referencing all `gen_ai.tool.*` semconvs including opt-in attributes, plus `gen_ai.tool.definitions` for LLM spans
6. **`telemetry/registry/resolved.json`** — Regenerate with `npm run telemetry:resolve`

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

We will implement all attributes — Required, Recommended, and Opt-In. The opt-in content attributes (`arguments`, `result`) are gated behind `OTEL_CAPTURE_AI_PAYLOADS` to prevent accidental data exposure, consistent with how we gate `gen_ai.input.messages`/`gen_ai.output.messages` on the root span.

---

## Milestones

### M1: Add GenAI attributes to tool spans *(complete)*

**Goal**: Tool spans have both `gen_ai.*` and `traceloop.*` attributes, including tool input/output content.

- [x] `gen_ai.operation.name`, `gen_ai.tool.name`, `gen_ai.tool.type`, `gen_ai.tool.call.id` set on active span
- [x] Import `trace` from `@opentelemetry/api` and `randomUUID` from `crypto`
- [x] Add `gen_ai.tool.description` — `ToolConfig` requires `description`, always set on span
- [x] Add `gen_ai.tool.call.arguments` — serializes tool input as JSON string, content-gated behind `OTEL_CAPTURE_AI_PAYLOADS`
- [x] Add `gen_ai.tool.call.result` — captures tool output after handler execution, content-gated behind `OTEL_CAPTURE_AI_PAYLOADS`
- [x] Update callers (`src/tools/langchain/index.ts`) to pass tool descriptions via config object

**Validation**:
- Run CLI with console exporter: `OTEL_TRACING_ENABLED=true OTEL_CAPTURE_AI_PAYLOADS=true vals exec -i -f .vals.yaml -- node dist/index.js "Find the broken pod and tell me why it's failing"`
- Verify tool spans contain `gen_ai.tool.call.arguments` (e.g., `{"resource":"pods","namespace":"all"}`)
- Verify tool spans contain `gen_ai.tool.call.result` (e.g., kubectl table output)
- Verify tool spans contain `gen_ai.tool.description`

### M2: Update Weaver schema *(complete)*

**Goal**: Attribute registry reflects all tool and LLM span attributes.

- [x] `registry.cluster_whisperer.tool` attribute group with refs to `gen_ai.operation.name`, `gen_ai.tool.name`, `gen_ai.tool.type`, `gen_ai.tool.call.id`
- [x] Add `gen_ai.tool.description` ref to tool attribute group (exists in OTel v1.37.0)
- [x] Add `gen_ai.tool.call.arguments`, `gen_ai.tool.call.result` as custom `id:` definitions (not yet standalone attributes in OTel v1.37.0 registry)
- [x] Add `gen_ai.tool.definitions` in new `registry.cluster_whisperer.llm` attribute group (custom `id:` definition)
- [x] Regenerate `telemetry/registry/resolved.json`
- [x] Validate with `npm run telemetry:check` and `npm run telemetry:resolve`

### M3: Add tool definitions to LLM spans *(complete)*

**Goal**: LLM/chat spans include `gen_ai.tool.definitions` — a JSON array describing available tools.

**Investigation result**: OpenLLMetry does NOT set `gen_ai.tool.definitions` on `anthropic.chat` spans. Option B confirmed — custom SpanProcessor needed.

- [x] Investigate whether OpenLLMetry sets `gen_ai.tool.definitions` — confirmed it does not
- [x] Create `ToolDefinitionsProcessor` SpanProcessor (`src/tracing/tool-definitions-processor.ts`) that intercepts `anthropic.chat` spans and sets `gen_ai.tool.definitions`
- [x] Register processor via `traceloop.initialize()`'s `processor` option (clean, supported API)
- [x] Lazy `require()` for tool metadata to break circular dependency: `tracing/index → processor → tools/core → utils/kubectl → tracing/index`
- [x] Tool definitions in OpenAI-style format with full JSON Schema from Zod via `zod-to-json-schema`
- [x] Validated: `gen_ai.tool.definitions` on all `anthropic.chat` spans with all 3 tools (names, descriptions, parameter schemas)

**Validation**:
- Run CLI with console exporter and check `anthropic.chat` span attributes for `gen_ai.tool.definitions`
- Verify the JSON array contains all three tools (`kubectl_get`, `kubectl_describe`, `kubectl_logs`) with names, descriptions, and parameter schemas

### M4: Verify in Datadog LLM Observability — CLI mode *(complete)*

**Goal**: Tool spans and LLM spans are fully populated in Datadog's LLM Observability trace view when run from CLI.

**Steps**:
1. Build: `npm run build`
2. Run CLI with OTLP export:
   ```bash
   OTEL_TRACING_ENABLED=true \
   OTEL_EXPORTER_TYPE=otlp \
   OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 \
   OTEL_CAPTURE_AI_PAYLOADS=true \
   vals exec -i -f .vals.yaml -- node dist/index.js "Find the broken pod and tell me why it's failing. Verify your answer with the logs."
   ```
3. Open Datadog APM traces: search for `service:cluster-whisperer`
4. Open the trace in LLM Observability view (the "LLM" badge view)
5. Verify tool and LLM spans

**Success criteria**:
- [x] Tool spans visible with "Tool" badge
- [x] Tool metadata panel shows `tool_id`, `tool_type: "function"`, and `tool_description`
- [x] Tool input panel shows arguments (e.g., `{"resource":"pods","namespace":"all"}`)
- [x] Tool output panel shows result (e.g., kubectl table output)
- [x] LLM spans show available tool definitions in metadata (`gen_ai.tool.definitions`)

### M5: Verify in Datadog LLM Observability — MCP mode

**Goal**: Same fidelity as M4 when run via MCP (Claude Code).

**Steps**:
1. Ensure `.mcp.json` has tracing environment variables enabled (OTEL_TRACING_ENABLED, OTEL_EXPORTER_TYPE=otlp, OTEL_CAPTURE_AI_PAYLOADS=true, etc.)
2. Restart Claude Code to pick up `.mcp.json` changes
3. Call the investigate tool via Claude Code (use the cluster-whisperer MCP server)
4. Open the resulting trace in Datadog LLM Observability view
5. Verify tool spans appear with full content

**Success criteria** (same as M4):
- Tool spans visible with "Tool" badge, metadata, input, and output populated
- LLM spans show tool definitions in metadata

---

## Progress Log

### 2026-02-10: M4 complete — all attributes verified in Datadog LLM Observability (CLI mode)
- Ran CLI with OTLP export to local Datadog Agent, full investigation question triggering all 3 tool types
- Trace `bff51b57a0753c66fbaf39c8ae82dfea`: 6 tool spans + 6 LLM spans, all with correct `gen_ai.*` attributes
- Tool spans: orange "Tool" badge, metadata panel shows `tool_description`, `tool_id`, `tool_type: "function"`
- Tool input panel: JSON arguments rendered correctly (e.g., `{"resource":"pods","namespace":"all"}`)
- Tool output panel: full kubectl output (pod tables, describe output) displayed in LLM Observability view
- LLM spans: blue "LLM" badge, `gen_ai.tool.definitions` confirmed on all `anthropic.chat` spans with all 3 tools
- Both `gen_ai.*` and `traceloop.*` attributes coexist — LLM Observability reads `gen_ai.*`, APM still has `traceloop.*`

### 2026-02-10: M3 complete — tool definitions injected into LLM chat spans via custom SpanProcessor
- Investigation: OpenLLMetry does NOT set `gen_ai.tool.definitions` on `anthropic.chat` spans — Option B confirmed
- Created `src/tracing/tool-definitions-processor.ts` — `ToolDefinitionsProcessor` SpanProcessor that intercepts `anthropic.chat` spans in `onStart()` and sets `gen_ai.tool.definitions`
- Registered via `traceloop.initialize()`'s undocumented `processor` option — clean API, no internal hacking
- Lazy `require()` pattern to break circular dependency: `tracing/index → processor → tools/core → utils/kubectl → tracing/index`
- Tool definitions use OpenAI-style format (`type: "function"` with nested function object) and full JSON Schema from `zod-to-json-schema`
- Cached on first span — tool definitions are static, computed once at runtime
- Validated with console exporter: `gen_ai.tool.definitions` on all 6 `anthropic.chat` spans (full investigation with logs verification), attribute does NOT leak to other span types
- Updated CLAUDE.md test question to include "Verify your answer with the logs." for more complete trace coverage (triggers all 3 tool types)

### 2026-02-10: M2 complete — Weaver schema fully updated with all tool + LLM span attributes
- Added `gen_ai.tool.description` as OTel `ref:` (exists in v1.37.0 registry)
- Added `gen_ai.tool.call.arguments` and `gen_ai.tool.call.result` as custom `id:` definitions — these are in the OTel GenAI span spec but not yet as standalone registry attributes in v1.37.0
- Created new `registry.cluster_whisperer.llm` attribute group with `gen_ai.tool.definitions` (custom `id:` definition for M3 LLM span work)
- `npm run telemetry:check` and `npm run telemetry:resolve` both pass
- Follows same pattern as `gen_ai.input.messages`/`gen_ai.output.messages` in root group — custom definitions for `gen_ai.*` attributes not yet in upstream registry

### 2026-02-10: M1 complete — all GenAI tool span attributes implemented and validated
- Changed `withToolTracing()` signature from bare `string` to `ToolConfig` object (`{ name, description }`)
- Added `gen_ai.tool.description` (always set), `gen_ai.tool.call.arguments` and `gen_ai.tool.call.result` (content-gated behind `isCaptureAiPayloads`)
- Result attribute set after handler execution to capture actual output
- Updated all 3 LangChain callers to pass descriptions via config object
- Corrected PRD: `src/tools/mcp/index.ts` doesn't use `withToolTracing()` — only LangChain callers needed updating
- Validated with console exporter: all 7 `gen_ai.*` attributes confirmed on tool spans (kubectl_get, kubectl_describe)

### 2026-02-10: Scope expanded — tool content attributes + tool definitions on LLM spans
- **Decision**: Don't defer opt-in attributes. Implement `gen_ai.tool.call.arguments`, `gen_ai.tool.call.result`, and `gen_ai.tool.description` on tool spans so Datadog LLM Observability shows full tool input/output content
- **Rationale**: The KubeCon demo needs the audience to see what each tool was called with and what it returned. "No Data" in the tool span panels defeats the purpose of LLM Observability visibility. The `traceloop.entity.input`/`traceloop.entity.output` values are invisible in LLM Observability — only `gen_ai.*` attributes are mapped
- **Additional scope**: Add `gen_ai.tool.definitions` to LLM/chat spans so observers can see which tools were available during each reasoning step
- **Impact**: M1 needs rework to add content attributes + description. M2 schema needs additional attribute refs. M3/M4 success criteria expanded to verify tool input/output panels + tool definitions

### 2026-02-10: M1 partially complete — GenAI attributes added to tool spans (needs rework)
- Modified `withToolTracing()` in `src/tracing/tool-tracing.ts` to set `gen_ai.operation.name`, `gen_ai.tool.name`, `gen_ai.tool.type`, `gen_ai.tool.call.id` on the active span after `withTool()` creates it
- Validated with console exporter: all 5 tool spans (kubectl_get x2, kubectl_describe x3) contain both `gen_ai.*` and `traceloop.*` attributes
- Build passes cleanly

### 2026-02-10: M2 partially complete — Weaver schema updated (needs rework)
- Added `registry.cluster_whisperer.tool` attribute group to `telemetry/registry/attributes.yaml` with refs to `gen_ai.operation.name`, `gen_ai.tool.name`, `gen_ai.tool.type`, `gen_ai.tool.call.id`
- Regenerated `telemetry/registry/resolved.json` — all 4 OTel refs expanded correctly
- `npm run telemetry:check` and `npm run telemetry:resolve` both pass
- Still needs: refs for `gen_ai.tool.description`, `gen_ai.tool.call.arguments`, `gen_ai.tool.call.result`, `gen_ai.tool.definitions`
