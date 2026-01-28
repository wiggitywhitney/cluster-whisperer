# PRD #6: OpenTelemetry Instrumentation

**Status**: Complete
**Created**: 2026-01-24
**GitHub Issue**: [#6](https://github.com/wiggitywhitney/cluster-whisperer/issues/6)

---

## Problem Statement

When the agent investigates a cluster, there's no visibility into what's happening internally. We can't see:
- Which tools were called and in what order
- How long each operation took
- Where failures occurred
- The full trace of an investigation

This matters for debugging, optimization, and demonstrating LLM observability concepts at KubeCon.

## Solution

Instrument the agent with OpenTelemetry to emit traces. This is backend-agnostic - traces can be sent to Jaeger, Datadog, or any OTel-compatible collector.

### Two Types of Spans (per Viktor's guidance)

1. **MCP tool spans**: When an MCP tool is invoked
2. **Agentic tool spans**: When kubectl subprocess is executed

This creates a hierarchy: MCP invocation → tool execution → kubectl call

---

## Research Approach

**Primary sources first, semantic conventions from the ground up.**

### Official Documentation (Primary)
- **OpenTelemetry JS SDK**: https://opentelemetry.io/docs/languages/js/
- **OpenTelemetry Semantic Conventions**: https://opentelemetry.io/docs/specs/semconv/
  - General conventions for spans, attributes, resources
  - GenAI semantic conventions (if available for LLM observability)
- **OpenTelemetry Weaver**: Tool for working with semantic conventions - evaluate if applicable

### Semantic Conventions Focus
Start with official semantic conventions rather than inventing attribute names:
- What conventions exist for HTTP/RPC calls?
- What conventions exist for subprocess/command execution?
- What conventions exist for GenAI/LLM operations?
- How should we name spans according to conventions?

### Questions to Answer During Research
1. What are the current OTel JS SDK packages and versions?
2. What semantic conventions apply to our span types (tool calls, subprocess execution)?
3. Are there GenAI semantic conventions for LLM tool use?
4. Does OpenTelemetry Weaver help with convention compliance?
5. What's the recommended tracer/provider setup pattern?
6. How do official examples structure span hierarchies?

### Viktor's Implementation (Compare, Don't Copy)
Study Viktor's dot-ai OTel implementation to understand his approach:
- What naming conventions does he use for spans and attributes?
- How does he structure the span hierarchy?
- **Compare against semantic conventions** - if Viktor's conventions differ from semconv, prefer semconv
- What can we learn from his integration architecture?

### Decisions to Make
- OTel SDK version and packages
- Which semantic conventions to follow (semconv takes precedence)
- Whether OpenTelemetry Weaver applies to our use case
- Span naming conventions (following semconv, noting where Viktor differs)
- What attributes to capture on each span type
- Default exporter (console for dev, OTLP for production)

---

## Success Criteria

- [x] MCP tool invocations create spans
- [x] kubectl executions create child spans
- [x] Traces visible in console output (for development)
- [x] Traces exportable via OTLP (for backends like Datadog)
- [x] Documentation explains OTel concepts and our implementation

## Milestones

- [x] **M1**: Research Phase
  - Study OpenTelemetry JS SDK documentation and official examples
  - Research OpenTelemetry semantic conventions (general + GenAI if available)
  - Evaluate OpenTelemetry Weaver for convention compliance
  - Study Viktor's naming conventions and compare against semconv
  - Research current SDK versions and patterns (landscape changing rapidly)
  - Document findings in `docs/opentelemetry-research.md`
  - Update this PRD with specific implementation decisions

- [x] **M2**: Basic OTel Setup
  - Install OTel SDK packages
  - Configure tracer provider
  - Add console exporter for development visibility
  - Create `docs/opentelemetry.md` explaining OTel concepts and our setup
  - Manual test: traces appear in console

- [x] **M3**: Instrument MCP Tools
  - **Before implementing**: Review `docs/opentelemetry-research.md` Section 6 for attribute decisions
  - Create spans for MCP tool invocations
  - Add relevant attributes (tool name, inputs, outputs)
  - Handle errors and set span status
  - Manual test: MCP tool calls create proper spans

- [x] **M4**: Instrument kubectl Execution
  - **Before implementing**: Review `docs/opentelemetry-research.md` Section 6 for kubectl attributes
  - Create child spans for kubectl subprocess calls
  - Add attributes (command, namespace, duration)
  - Capture errors and exit codes
  - Manual test: kubectl calls show as child spans

- [x] **M5**: OTLP Export
  - **Before implementing**: Review `docs/opentelemetry-research.md` Section 5 for Datadog OTLP details
  - **Test environment**: Spider Rainbows kind cluster (`~/Documents/Repositories/spider-rainbows`)
    - Setup: `./setup-platform.sh`
    - Teardown: `./destroy.sh`
  - **Secrets**: Add to `.vals.yaml`:
    ```yaml
    DD_API_KEY: ref+gcpsecrets://demoo-ooclock/datadog-commit-story-dev
    DD_APP_KEY: ref+gcpsecrets://demoo-ooclock/datadog-commit-story-app
    ```
  - Install Datadog Agent in cluster with OTLP receiver enabled (port 4318):
    ```bash
    helm install datadog datadog/datadog \
      --set datadog.apiKey=$DD_API_KEY \
      --set datadog.site=datadoghq.com \
      --set datadog.otlp.receiver.protocols.http.enabled=true
    ```
  - Configure OTLP exporter alongside console exporter
  - Environment variable `OTEL_EXPORTER_OTLP_ENDPOINT` for collector endpoint
  - Backend-agnostic design: same code works with Jaeger or Datadog
  - Verify traces reach Datadog APM (US1 site: datadoghq.com)
  - Update documentation with export configuration for both backends

## Technical Approach

### OTel SDK Packages (SDK 2.0)

```bash
npm install @opentelemetry/sdk-node \
  @opentelemetry/api \
  @opentelemetry/sdk-trace-node \
  @opentelemetry/exporter-trace-otlp-proto \
  @opentelemetry/resources \
  @opentelemetry/semantic-conventions
```

### Tracer Initialization

- Use `NodeSDK` with manual instrumentation only (`instrumentations: []`)
- Opt-in via `OTEL_TRACING_ENABLED` environment variable
- Get tracer at point of use, not exported globally

### Span Structure

| Operation | Span Name | Span Kind |
|-----------|-----------|-----------|
| MCP Tool Call | `execute_tool {tool_name}` | INTERNAL |
| kubectl Execution | `kubectl {operation} {resource}` | CLIENT |

### Attribute Strategy

**Both Viktor's AND semconv attributes** for head-to-head comparison capability.

See `docs/opentelemetry-research.md` Section 6 for full attribute mapping.

### Exporter Configuration

- **Development**: Console exporter
- **Production**: OTLP to Datadog Agent (port 4318)

## Reference Sources

- **OpenTelemetry JS SDK**: [OTel JS docs](https://opentelemetry.io/docs/languages/js/) (primary)
- **OpenTelemetry Semantic Conventions**: [OTel semconv](https://opentelemetry.io/docs/specs/semconv/) (primary)
- **OpenTelemetry Weaver**: [Weaver repo](https://github.com/open-telemetry/weaver) (evaluate applicability)
- **Viktor's observability guide**: [Guide](https://devopstoolkit.ai/docs/mcp/guides/observability-guide)
- **Viktor's dot-ai**: Reference for integration architecture, compare naming conventions

## Out of Scope

- Metrics (traces only for POC)
- Logs correlation (future work)
- Automatic instrumentation of HTTP calls
- Sampling strategies (trace everything for POC)

## Dependencies

- MCP server (from PRD #5) - for MCP tool spans
- Existing kubectl tools (from PRD #1) - for kubectl spans
- Spider Rainbows kind cluster - test environment for M5
- Datadog Agent with OTLP receiver - for M5 verification
- vals + Google Secrets Manager - for DD_API_KEY injection (see commit-story for secret paths)

## Testing

Manual verification:
1. Console output shows span hierarchy (M2-M4)
2. Spans include expected attributes (M3-M4)
3. Errors are properly captured (M3-M4)
4. OTLP export reaches Datadog Agent (M5)
5. Traces visible in Datadog APM UI (M5)
6. Same code works with Jaeger endpoint (M5 - verify backend-agnostic design)

---

## Design Decisions

### 2026-01-27: M1 Research Decisions

**OpenTelemetry Weaver**: Not applicable. The `@opentelemetry/semantic-conventions` npm package already provides TypeScript constants. Weaver solves org-scale governance problems we don't have.

**Attribute naming**: Use both Viktor's attributes AND OTel semantic conventions on each span. This enables head-to-head comparison queries (Viktor's) while maintaining standards compliance (semconv). Cost is a few extra bytes per span.

**Manual instrumentation**: All manual, no auto-instrumentation. Our spans are at business logic boundaries (MCP tool calls, kubectl subprocess) which auto-instrumentation doesn't help with.

**Datadog integration**: Use Datadog Agent with OTLP ingestion (port 4318), not direct OTLP to Datadog endpoint. Direct OTLP for traces is only GA for LLM Observability, not general APM. Updated PRD #8 with this finding.

### 2026-01-28: M5 Pre-Implementation Decisions

**Test environment**: Use Spider Rainbows kind cluster (already running) as the test environment. Install Datadog Agent into this cluster rather than creating new infrastructure.

**Secrets management**: Use vals to inject Datadog credentials (DD_API_KEY) from Google Secrets Manager. The commit-story repo has the paths to these secrets in Google Secrets Manager.

**Backend flexibility**: The OTLP exporter must be backend-agnostic. The KubeCon demo gives the audience a choice between Jaeger and Datadog for observability (Scenario 3). The same cluster-whisperer code should work with either backend - only the `OTEL_EXPORTER_OTLP_ENDPOINT` changes.

**Datadog is mandatory**: Whitney works at Datadog, so Datadog support is required (not optional). Jaeger support is also needed for KubeCon demo completeness, but Datadog is the priority for M5 verification.

**KubeCon demo context**: This PRD is part of a larger demo with 3 scenarios and 8 possible technology combinations (see `docs/project-state.md`). The observability backend is one of three audience choice points.

---

## Progress Log

### 2026-01-27: M1 Research Complete

- Created `docs/opentelemetry-research.md` with comprehensive findings
- Researched OTel JS SDK 2.0 packages and setup patterns
- Analyzed OTel semantic conventions (GenAI for tools, Process for kubectl)
- Evaluated OpenTelemetry Weaver (not applicable)
- Analyzed Viktor's dot-ai implementation (spans, attributes, hierarchy)
- Researched Datadog OTLP ingestion options
- Made key decisions: dual attributes (Viktor + semconv), manual instrumentation, Datadog Agent approach
- Updated PRD #8 with Datadog OTLP finding

### 2026-01-27: M2 Basic OTel Setup Complete

- Installed OTel SDK packages (@opentelemetry/sdk-node, api, sdk-trace-node, exporter-trace-otlp-proto, resources, semantic-conventions)
- Created `src/tracing/index.ts` with NodeSDK initialization and ConsoleSpanExporter
- Configured opt-in tracing via `OTEL_TRACING_ENABLED` environment variable
- Added tracing import to both entry points (`src/index.ts`, `src/mcp-server.ts`)
- Created `docs/opentelemetry.md` explaining OTel concepts and our setup
- Exported `getTracer()` function for M3/M4 instrumentation work
- Manual test passed: tracing initialization messages appear when enabled

### 2026-01-28: M3 Instrument MCP Tools Complete

- Created `src/tracing/tool-tracing.ts` with `withToolTracing()` wrapper function
- Wrapped all 3 MCP tools (kubectl_get, kubectl_describe, kubectl_logs) in `src/tools/mcp/index.ts`
- Implemented dual attribute strategy: Viktor's attributes + OTel semconv for comparison capability
- Attributes captured: `gen_ai.tool.name`, `gen_ai.tool.input`, `gen_ai.tool.call.arguments`, `gen_ai.tool.duration_ms`, `gen_ai.tool.success`
- Error handling: exceptions recorded with `recordException()`, tool failures (isError) set `gen_ai.tool.success: false`
- Updated `src/tracing/index.ts` to use SimpleSpanProcessor for immediate span output during development
- Updated `docs/opentelemetry.md` with M3 implementation details and attribute documentation
- Added "Before implementing" reminders to M3/M4/M5 milestones to reference research doc
- Manual test passed: spans appear immediately with all expected attributes

### 2026-01-28: M4 Instrument kubectl Execution Complete

- Added OpenTelemetry instrumentation to `src/utils/kubectl.ts`
- Created `extractKubectlMetadata()` helper to parse operation/resource/namespace from args
- Wrapped `spawnSync` in `startActiveSpan` with span name `kubectl {operation} {resource}`
- Span kind: CLIENT (outbound subprocess call), auto-parented under MCP tool spans
- Dual attribute strategy implemented:
  - Viktor's: `k8s.client`, `k8s.operation`, `k8s.resource`, `k8s.namespace`, `k8s.args`, `k8s.duration_ms`
  - Semconv: `process.executable.name`, `process.command_args`, `process.exit.code`, `error.type`
- Error handling: spawn errors recorded with `recordException()`, non-zero exit codes set `error.type: KubectlError`
- Updated `docs/opentelemetry.md` with M4 section including attributes table and example output
- Manual test passed: kubectl spans appear as children of MCP tool spans with correct `parentSpanContext`

### 2026-01-28: M5 OTLP Export Complete

- Added OTLP exporter support to `src/tracing/index.ts`
- New environment variables: `OTEL_EXPORTER_TYPE` (console|otlp), `OTEL_EXPORTER_OTLP_ENDPOINT`
- Installed Datadog Agent in Spider Rainbows cluster with OTLP receiver (port 4318)
- Added Datadog secrets to `.vals.yaml` (DD_API_KEY, DD_APP_KEY)
- Fixed span hierarchy context propagation in `src/tracing/tool-tracing.ts` using `context.with()`
- Verified traces in Datadog APM with correct parent-child hierarchy (MCP tool → kubectl)
- Backend-agnostic design: same code works with Datadog or Jaeger (only endpoint changes)
- Updated `docs/opentelemetry.md` with OTLP export instructions for Datadog and Jaeger
- Updated `docs/project-state.md` with M5 status and architectural notes
- Note: Current deployment (local agent + in-cluster Datadog) requires port-forward; better approaches documented for KubeCon demo
