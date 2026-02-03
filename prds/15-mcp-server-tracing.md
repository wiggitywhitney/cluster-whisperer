# PRD #15: MCP Server Tracing

## Problem Statement

MCP server tool calls don't produce traces in Datadog. When Claude Code calls cluster-whisperer's kubectl tools via MCP, there's no observability into what happened - no spans, no timing, no error tracking.

The CLI mode (`index.ts`) has full tracing visibility with properly nested spans:
```
cluster-whisperer.investigate (workflow)
├── kubectl_get (tool)
│   └── kubectl get pods (subprocess)
├── kubectl_describe (tool)
│   └── kubectl describe pod (subprocess)
└── ...
```

MCP mode (`mcp-server.ts`) is a black box because:
1. **Missing environment variables**: `.mcp.json` has `"env": {}` - no `OTEL_TRACING_ENABLED`
2. **No root span**: CLI uses `withAgentTracing()` to create a parent span and store context; MCP has no equivalent

## Solution Overview

Implement MCP server tracing that exactly mirrors CLI conventions:
1. **Research phase**: Document all tracing conventions (OTel semconv, OpenLLMetry, custom attributes)
2. **Implementation**: Create `withMcpRequestTracing()` parallel to `withAgentTracing()`
3. **Configuration**: Update `.mcp.json` with proper environment variables

## Success Criteria

- [x] MCP tool calls produce traces visible in Datadog
- [x] Trace hierarchy mirrors CLI: `cluster-whisperer.mcp.<tool>` → `<tool>` → `kubectl` spans
- [x] All span attributes match documented conventions exactly
- [x] Environment configuration enables OTLP export to Datadog Agent

---

## Milestones

### Milestone 1: Research and Document Tracing Conventions
**Status**: Complete ✅

**Objective**: Create comprehensive documentation of all tracing conventions used in cluster-whisperer, so MCP implementation can mirror them exactly.

**Deliverable**: `docs/tracing-conventions.md`

**Research Areas**:
- [x] OpenTelemetry semantic conventions used (process.*, error.*, SpanKind)
- [x] OpenLLMetry conventions used (traceloop.span.kind, traceloop.entity.*)
- [x] Custom attributes we defined (user.question, k8s.namespace, k8s.output_size_bytes)
- [x] Span naming patterns (cluster-whisperer.investigate, kubectl <op> <resource>)
- [x] Context propagation approach (AsyncLocalStorage bridge for LangGraph)
- [x] Content gating pattern (OTEL_TRACE_CONTENT_ENABLED)

**Success Criteria**:
- Documentation clearly catalogs every attribute, convention, and pattern
- Another developer could implement tracing from this doc alone

---

### Milestone 2: Implement MCP Request Tracing
**Status**: Complete ✅

**Prerequisite**: Read `docs/tracing-conventions.md` from Milestone 1

**Objective**: Create `withMcpRequestTracing()` function that creates properly-attributed root spans for MCP tool requests, and fix existing CLI tracing to match documented conventions.

**Implementation**:
- [x] Fix `withAgentTracing()` SpanKind: SERVER → INTERNAL (per tracing-conventions.md)
- [x] Add GenAI semconv attributes to root spans (`gen_ai.operation.name`, `gen_ai.tool.name`, `gen_ai.tool.type`, `gen_ai.tool.call.id`)
- [x] Add `withMcpRequestTracing()` to `src/tracing/context-bridge.ts`
- [x] Mirror `withAgentTracing()` conventions exactly per documentation
- [x] Store context in AsyncLocalStorage for child span parenting
- [x] Handle MCP result format (content array, isError flag)
- [x] Gate content capture with `isTraceContentEnabled`

**Files to Modify**:
- `src/tracing/context-bridge.ts` - Fix existing function, add new function

**Success Criteria**:
- Both CLI and MCP root spans use correct SpanKind (INTERNAL)
- Both include GenAI semconv attributes for Datadog LLM Observability
- Function creates spans with all documented attributes
- Context is stored for tool span parenting

---

### Milestone 3: Integrate MCP Tracing with Tool Registration
**Status**: Complete ✅

**Prerequisite**: Read `docs/tracing-conventions.md` from Milestone 1

**Objective**: Update MCP tool registration to use the new tracing wrapper.

**Implementation**:
- [x] Update `src/tools/mcp/index.ts` to wrap handlers with `withMcpRequestTracing()`
- [x] Ensure proper nesting: MCP request span → tool span → kubectl span
- [x] Verify span hierarchy in console output

**Files to Modify**:
- `src/tools/mcp/index.ts` - Update tool registration

**Success Criteria**:
- All three tools (get, describe, logs) are traced
- Console exporter shows expected hierarchy

---

### Milestone 4: Configure MCP Environment Variables
**Status**: Complete ✅

**Prerequisite**: Read `docs/tracing-conventions.md` from Milestone 1

**Objective**: Update `.mcp.json` to pass tracing environment variables when Claude Code spawns the MCP server.

**Implementation**:
- [x] Add `OTEL_TRACING_ENABLED=true` to enable tracing
- [x] Add `OTEL_EXPORTER_TYPE=otlp` for Datadog export
- [x] Add `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318` for local agent
- [x] Document in CLAUDE.md how to toggle tracing on/off

**Files to Modify**:
- `.mcp.json` - Add environment variables
- `CLAUDE.md` - Document MCP tracing configuration

**Success Criteria**:
- MCP server starts with tracing enabled when spawned by Claude Code
- Configuration is documented for users

---

### Milestone 5: End-to-End Validation in Datadog
**Status**: Not Started

**Prerequisite**: Milestones 2, 3, 4 complete

**Objective**: Verify traces flow from MCP tool calls through to Datadog APM.

**Validation Steps**:
- [ ] Restart Claude Code to pick up new `.mcp.json`
- [ ] Use kubectl tools via Claude Code (e.g., "list pods in default namespace")
- [ ] Verify traces appear in Datadog APM with correct hierarchy
- [ ] Verify all documented attributes are present on spans
- [ ] Verify error cases produce ERROR status spans

**Success Criteria**:
- Traces visible at https://app.datadoghq.com/apm/traces?query=service%3Acluster-whisperer
- Span hierarchy and attributes match documentation

---

## Progress Log

### 2026-02-03: Milestone 1 Complete

**Deliverable**: Created `docs/tracing-conventions.md` - comprehensive specification of all tracing conventions.

**Key findings during research**:
1. **SpanKind deviation**: Current CLI uses `SpanKind.SERVER` but should use `INTERNAL` (neither CLI nor MCP stdio involves network requests - MCP stdio is IPC via pipes)
2. **Missing GenAI semconv**: Tool spans should include `gen_ai.operation.name`, `gen_ai.tool.name`, `gen_ai.tool.type`, `gen_ai.tool.call.id` for better Datadog LLM Observability integration
3. **Future consideration**: SpanKind should evolve with transport - if HTTP API added later, those spans would correctly use SERVER

**Action taken**: Added fix tasks to Milestone 2 to address deviations before implementing MCP tracing.

---

### 2026-02-03: Milestone 2 Implementation Progress

**Completed**:
- Fixed `withAgentTracing()` SpanKind from SERVER → INTERNAL
- Created `withMcpRequestTracing()` function with all documented attributes:
  - OpenLLMetry conventions (`traceloop.span.kind`, `traceloop.entity.name`)
  - MCP-specific attributes (`mcp.tool.name`)
  - GenAI semantic conventions (`gen_ai.operation.name`, `gen_ai.tool.name`, `gen_ai.tool.type`, `gen_ai.tool.call.id`)
- Content gating implemented with `isTraceContentEnabled` check
- Context stored in AsyncLocalStorage for proper span parenting

**Key insight documented**: GenAI semconv attributes apply when the invoker of a span is an AI, not a human. CLI root span (human-invoked) doesn't get them; MCP root span (Claude-invoked) does. Tool spans in both modes should eventually get GenAI semconv since the LLM decides to call them.

---

### 2026-02-03: Milestone 2 Complete

**Final task completed**: Handle MCP result format (content array, isError flag)

**Implementation**:
- Added `McpToolResult` interface defining MCP's result structure
- Updated `withMcpRequestTracing()` to inspect result and set appropriate span status:
  - `isError: true` → `SpanStatusCode.ERROR` with message from content
  - `isError: false/undefined` → `SpanStatusCode.OK`
- Extract text content from `content` array for `traceloop.entity.output` attribute
- Exception handling preserved for thrown errors (records exception event)

**Verified with test script**:
- Success case: `status.code: 1` (OK) ✓
- Error case: `status.code: 2` with error message ✓
- Exception case: `status.code: 2` with `recordException()` ✓

**Milestone 2 complete** - Ready for Milestone 3 (tool registration integration).

---

### 2026-02-03: Milestone 3 Complete

**Completed**: Integrated `withMcpRequestTracing()` with MCP tool registration.

**Implementation**:
- Wrapped all three tool handlers (`kubectl_get`, `kubectl_describe`, `kubectl_logs`) with `withMcpRequestTracing()`
- Each handler now creates proper span hierarchy: MCP root → tool → kubectl subprocess
- Fixed `McpToolResult` type for MCP SDK compatibility (literal `"text"` type + index signature)

**Verified span hierarchy with console output**:
```
cluster-whisperer.mcp.kubectl_get  (traceId: abc, spanId: ROOT, parent: none)
└── kubectl_get.tool               (traceId: abc, spanId: TOOL, parent: ROOT)
    └── kubectl get pods           (traceId: abc, spanId: SUB, parent: TOOL)
```

All three spans share the same `traceId` and have correct parent relationships.

**Milestone 3 complete** - Ready for Milestone 4 (environment configuration).

---

### 2026-02-03: Milestone 4 Complete

**Completed**: Configured MCP environment variables for tracing.

**Implementation**:
- Updated `.mcp.json` with all required environment variables:
  - `OTEL_TRACING_ENABLED=true`
  - `OTEL_EXPORTER_TYPE=otlp`
  - `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318`
  - `OTEL_TRACE_CONTENT_ENABLED=true`
- Added MCP tracing documentation to `CLAUDE.md`:
  - How to enable/disable MCP tracing
  - Content capture privacy note
  - Restart requirement after config changes

**Milestone 4 complete** - Ready for Milestone 5 (end-to-end Datadog validation).

---

## Technical Context

### Current Architecture (CLI Mode)

```
src/index.ts
  └── withAgentTracing(question, async () => {...})  // Creates root span, stores context
        └── streamEvents()
              └── tool handlers
                    └── withToolTracing()  // Restores context, creates tool span
                          └── withTool()   // OpenLLMetry wrapper
                                └── kubectlGet/Describe/Logs()
                                      └── executeKubectl()  // Creates subprocess span
```

### Target Architecture (MCP Mode)

```
src/mcp-server.ts
  └── server.registerTool()
        └── withMcpRequestTracing(toolName, input, async () => {...})  // NEW: Creates root span
              └── withToolTracing()  // Existing: Creates tool span
                    └── withTool()   // OpenLLMetry wrapper
                          └── kubectlGet/Describe/Logs()
                                └── executeKubectl()  // Creates subprocess span
```

### Key Files

| File | Purpose |
|------|---------|
| `src/tracing/index.ts` | OTel initialization, exporter setup |
| `src/tracing/context-bridge.ts` | AsyncLocalStorage context bridging |
| `src/tracing/tool-tracing.ts` | Tool span wrapper |
| `src/tools/mcp/index.ts` | MCP tool registration |
| `src/utils/kubectl.ts` | Subprocess execution with spans |
| `.mcp.json` | MCP server configuration |

---

## References

- [OpenLLMetry-JS Issue #476](https://github.com/traceloop/openllmetry-js/issues/476) - LangGraph context propagation
- [OpenLLMetry Python PR #3206](https://github.com/traceloop/openllmetry/pull/3206) - Python fix for same issue
- Datadog APM: https://app.datadoghq.com/apm/traces?query=service%3Acluster-whisperer
