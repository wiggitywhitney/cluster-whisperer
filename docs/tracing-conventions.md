# Tracing Conventions

This document explains how tracing works in cluster-whisperer, the architectural decisions behind it, and how to implement tracing for new entry points.

**Audience**: Developers implementing tracing for new entry points (MCP server, future APIs)

> **Attribute Definitions**: For the complete list of span attributes (names, types, descriptions), see the [auto-generated attribute reference](telemetry-generated/attributes/cluster-whisperer.md) produced by `npm run telemetry:docs`. The source of truth is the Weaver schema in `telemetry/registry/attributes.yaml`. This document focuses on architecture, context propagation, and design rationale.

---

## Table of Contents

1. [Span Hierarchy](#span-hierarchy)
2. [Root Span Conventions](#root-span-conventions)
3. [Tool Span Conventions](#tool-span-conventions)
4. [Subprocess Span Conventions](#subprocess-span-conventions)
5. [Vercel Agent Tracing](#vercel-agent-tracing)
6. [Context Propagation](#context-propagation)
7. [Content Gating](#content-gating)
8. [Deviations from Standards](#deviations-from-standards)

---

## Span Hierarchy

Both CLI and MCP modes share a root span and tool spans. The CLI agent adds framework-specific spans between root and tool levels.

### LangGraph Agent

```text
cluster-whisperer.cli.investigate          (root, workflow layer)
├── anthropic.chat                         (OpenLLMetry, llm layer)
├── kubectl_get.tool                       (withToolTracing, tool layer)
│   └── kubectl get pods -A                (subprocess)
└── kubectl_describe.tool                  (withToolTracing, tool layer)
    └── kubectl describe pod demo-app-xxx  (subprocess)
```

### Vercel Agent

```text
cluster-whisperer.cli.investigate          (root, workflow layer)
├── vercel.agent                           (SDK, ai.operationId=ai.streamText, agent layer)
│   ├── text.stream                        (SDK, ai.operationId=ai.streamText.doStream, llm layer)
│   │   └── cluster-whisperer-investigate  (SDK, ai.operationId=ai.toolCall, tool layer)
│   └── text.stream                        (step 2, llm layer)
├── kubectl_get.tool                       (withToolTracing, tool layer)
│   └── kubectl get pods -A                (subprocess)
└── kubectl_describe.tool                  (withToolTracing, tool layer)
    └── kubectl describe pod demo-app-xxx  (subprocess)
```

The Vercel agent produces **double tool spans**: SDK `ai.toolCall` spans alongside our `<toolName>.tool` spans. Both appear in traces intentionally — SDK spans carry `ai.toolCall.*` attributes, ours carry `gen_ai.tool.*` attributes for the shared contract.

### MCP Mode

```text
cluster-whisperer.mcp.<tool>               (root, workflow layer)
└── <tool>.tool                            (withToolTracing, tool layer)
    └── kubectl {op} {resource}            (subprocess)
```

| Level | CLI LangGraph | CLI Vercel | MCP Mode |
|-------|---------------|------------|----------|
| Root | `cluster-whisperer.cli.investigate` | `cluster-whisperer.cli.investigate` | `cluster-whisperer.mcp.<tool>` |
| Agent | — | `vercel.agent` (SDK) | — |
| LLM | `anthropic.chat` (OpenLLMetry) | `text.stream` (SDK) | — |
| Tool | `<tool>.tool` (withToolTracing) | `<tool>.tool` + SDK `ai.toolCall` | `<tool>.tool` (withToolTracing) |
| Subprocess | `kubectl {op} {resource}` | `kubectl {op} {resource}` | `kubectl {op} {resource}` |

---

## Root Span Conventions

The root span wraps the entire operation and stores context for child span parenting.

### CLI Mode: `withAgentTracing()`

**File**: `src/tracing/context-bridge.ts`

| Property | Value |
|----------|-------|
| **Span Name** | `cluster-whisperer.investigate` |
| **SpanKind** | `INTERNAL` |

Attributes: See `registry.cluster_whisperer.root` in `telemetry/registry/attributes.yaml`

### MCP Mode: `withMcpRequestTracing()`

**File**: `src/tracing/context-bridge.ts`

| Property | Value |
|----------|-------|
| **Span Name** | `cluster-whisperer.mcp.<toolName>` |
| **SpanKind** | `INTERNAL` |

Attributes: See `registry.cluster_whisperer.mcp` in `telemetry/registry/attributes.yaml`

**Key difference**: MCP mode includes GenAI semantic convention attributes (`gen_ai.*`) for Datadog LLM Observability integration. CLI mode does not include these because the root span is human-invoked, not AI-invoked.

---

## Tool Span Conventions

Tool spans are created by OpenLLMetry's `withTool()` wrapper.

**File**: `src/tracing/tool-tracing.ts`

**Wrapper**: `withToolTracing()` calls `withTool()` inside `withStoredContext()`

| Property | Value |
|----------|-------|
| **Span Name** | Set by OpenLLMetry (typically `<toolName>.tool`) |
| **SpanKind** | `INTERNAL` (set by OpenLLMetry) |

**Attributes** (set by OpenLLMetry):

| Attribute | Source | Description |
|-----------|--------|-------------|
| `traceloop.span.kind` | OpenLLMetry | `"tool"` |
| `traceloop.entity.name` | OpenLLMetry | Tool name from config |

**Note**: We pass `{ name: toolName }` to `withTool()`. OpenLLMetry handles attribute population.

---

## Subprocess Span Conventions

Subprocess spans track kubectl command execution.

**File**: `src/utils/kubectl.ts`

| Property | Value |
|----------|-------|
| **Span Name** | `kubectl {operation} {resource}` |
| **SpanKind** | `CLIENT` |

Attributes: See `registry.cluster_whisperer.subprocess` in `telemetry/registry/attributes.yaml`

The subprocess group includes OTel Process semantic convention references (`process.*`, `error.*`) and custom Kubernetes-specific attributes (`cluster_whisperer.k8s.*`).

### Error Handling

| Scenario | `process.exit.code` | `error.type` | Span Status |
|----------|---------------------|--------------|-------------|
| Success | `0` | Not set | `OK` |
| Non-zero exit | Exit code | `"KubectlError"` | `ERROR` |
| Spawn failure | `-1` | Error class name | `ERROR` |
| Exception | `-1` | Error class name | `ERROR` |

### Sensitive Argument Redaction

These flags have their values redacted in `process.command_args`:

- `--token`
- `--password`
- `--client-key`
- `--client-certificate`
- `--kubeconfig`

Example: `["kubectl", "--token", "[REDACTED]", "get", "pods"]`

---

## Vercel Agent Tracing

The Vercel AI SDK produces its own spans via `experimental_telemetry`. These coexist with our shared tracing infrastructure (`withToolTracing`, subprocess spans).

### SDK Telemetry Configuration

**File**: `src/agent/vercel-agent.ts`

```typescript
experimental_telemetry: {
  isEnabled: true,
  functionId: 'cluster-whisperer-investigate',
  metadata: { agent: 'vercel' },
  tracer: trace.getTracer('ai'),  // Uses our registered TracerProvider
}
```

The `tracer` parameter ensures Vercel SDK spans nest under our root span (same TracerProvider, same trace context).

### LLM Span Name Differences

The two agent frameworks produce different LLM span names because they use different instrumentation libraries:

| Aspect | LangGraph | Vercel |
|--------|-----------|--------|
| LLM instrumentation | OpenLLMetry auto-instrumentation | SDK `experimental_telemetry` |
| LLM span name | `anthropic.chat` | `text.stream` |
| Outer agent span | — | `vercel.agent` |
| `gen_ai.*` attributes on | `anthropic.chat` spans | `text.stream` spans (inner only) |

Both carry the same `gen_ai.system`, `gen_ai.request.model`, `gen_ai.usage.*` attributes — Datadog LLM Observability reads these for token usage dashboards regardless of span name.

### VercelSpanProcessor

**File**: `src/tracing/vercel-span-processor.ts`

The Vercel AI SDK sets `gen_ai.*` attributes on its spans but does **not** set `gen_ai.operation.name`. Without this attribute, Datadog classifies all spans as "workflow" regardless of their role.

The `VercelSpanProcessor` reads `ai.operationId` (set by the SDK) and adds the missing attribute:

| `ai.operationId` | Added `gen_ai.operation.name` | Datadog Layer |
|-------------------|-------------------------------|---------------|
| `ai.streamText.doStream` | `"chat"` | llm |
| `ai.streamText` | `"invoke_agent"` | agent |
| `ai.toolCall` | Already has `"execute_tool"` | tool |

The processor also adds `gen_ai.agent.name: "cluster-whisperer"` to `ai.streamText` spans for the agent layer.

Registered in `src/tracing/index.ts` alongside the existing `ToolDefinitionsProcessor` via a `MultiSpanProcessor`.

### Datadog LLM Observability Layers

With the SpanProcessor enrichment, both agents produce readable investigation stories in Datadog:

| Layer | LangGraph Source | Vercel Source |
|-------|-----------------|---------------|
| **workflow** | Root span (no `gen_ai.operation.name`) | Root span (no `gen_ai.operation.name`) |
| **agent** | — | `vercel.agent` span (`gen_ai.operation.name: "invoke_agent"`) |
| **llm** | `anthropic.chat` (OpenLLMetry sets `gen_ai.operation.name: "chat"`) | `text.stream` spans (`gen_ai.operation.name: "chat"` via SpanProcessor) |
| **tool** | `<tool>.tool` spans (`gen_ai.operation.name: "execute_tool"`) | `<tool>.tool` + SDK `ai.toolCall` spans |

The Vercel agent has an additional **agent** layer that LangGraph does not — acceptable asymmetry since the Vercel SDK provides richer hierarchy.

See `docs/research/49-m7-datadog-llmobs-otel-mapping.md` for the full mapping research.

### Summarized Thinking Output

Both agents show condensed reasoning in "Thinking:" blocks, not full thinking tokens. The LangGraph agent receives summarized thinking from LangChain's event stream. The Vercel agent receives `reasoning-delta` parts which contain the model's summarized reasoning text. The CLI output looks identical for both — the audience cannot tell which agent framework is running.

---

## Context Propagation

### The Problem

LangGraph breaks Node.js async context propagation. Without intervention, tool spans end up in separate traces instead of nesting under the root span.

**Upstream issue**: [traceloop/openllmetry-js#476](https://github.com/traceloop/openllmetry-js/issues/476)

### The Solution

We use explicit `AsyncLocalStorage` to bridge the context gap:

```text
┌─────────────────────────────────────────────────────────┐
│ withAgentTracing() / withMcpRequestTracing()            │
│   1. Create root span                                   │
│   2. Store context in AsyncLocalStorage                 │
│   3. Store span reference for setTraceOutput()          │
│   4. Run the wrapped function                           │
└─────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────┐
│ withStoredContext() (called by withToolTracing)         │
│   1. Retrieve stored context from AsyncLocalStorage     │
│   2. Make it the active context                         │
│   3. Run withTool() inside this context                 │
└─────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────┐
│ Tool handler                                            │
│   - Calls executeKubectl()                              │
│   - Subprocess span auto-parents under tool span        │
└─────────────────────────────────────────────────────────┘
```

### Key Functions

| Function | File | Purpose |
|----------|------|---------|
| `withAgentTracing()` | `context-bridge.ts` | Creates root span, stores context (CLI) |
| `withMcpRequestTracing()` | `context-bridge.ts` | Creates root span, stores context (MCP) |
| `getStoredContext()` | `context-bridge.ts` | Retrieves stored context |
| `withStoredContext()` | `context-bridge.ts` | Runs function with stored context active |
| `setTraceOutput()` | `context-bridge.ts` | Sets output attribute on root span |
| `withToolTracing()` | `tool-tracing.ts` | Wraps tool handler with context bridge + withTool |

### Implementation Pattern for MCP

```typescript
// In MCP tool handler
const result = await withMcpRequestTracing(toolName, input, async () => {
  return withToolTracing(toolName, async () => {
    return actualToolLogic(input);
  })(input);
});
```

---

## Content Gating

Sensitive content (user questions, tool inputs/outputs) is only captured when explicitly enabled.

### Environment Variable

```bash
OTEL_CAPTURE_AI_PAYLOADS=true  # Default: false (disabled)
```

Content-gated attributes are marked in the Weaver schema with a note referencing `OTEL_CAPTURE_AI_PAYLOADS`. These include:

| Attribute | Purpose |
|-----------|---------|
| `cluster_whisperer.user.question` | User's natural language question |
| `traceloop.entity.input` | OpenLLMetry input content |
| `traceloop.entity.output` | OpenLLMetry output content |
| `gen_ai.input.messages` | OTel v1.37+ input for Datadog CONTENT column |
| `gen_ai.output.messages` | OTel v1.37+ output for Datadog CONTENT column |

### Implementation

```typescript
import { isCaptureAiPayloads } from "./index";

if (isCaptureAiPayloads) {
  span.setAttribute("cluster_whisperer.user.question", question);
  span.setAttribute("traceloop.entity.input", question);
  // OTel v1.37+ format for Datadog LLM Observability CONTENT column
  span.setAttribute("gen_ai.input.messages", JSON.stringify([
    { role: "user", parts: [{ type: "text", content: question }] },
  ]));
}
```

The `gen_ai.output.messages` attribute is set separately via `setTraceOutput()` after the agent completes.

### Security Rationale

- Prompts and completions may contain sensitive user data
- Telemetry pipelines may have broad access
- Default to secure (disabled) to prevent accidental exposure
- Users explicitly opt-in for development/debugging

---

## Deviations from Standards

### 1. SpanKind for Root Span ✅ Fixed

**What we do**: Root spans use `SpanKind.INTERNAL`

**Official guidance**: SERVER is for "server-side handling of a remote request while the client awaits a response"

**Why INTERNAL is correct**:
- CLI mode processes a local command-line argument, not a network request
- MCP mode (stdio transport) communicates via stdin/stdout pipes with a parent process - this is inter-process communication, not a network request

**Current value**: `SpanKind.INTERNAL` - both modes are internal operations within the application

**Status**: Fixed in PRD #15 Milestone 2. Both `withAgentTracing()` and `withMcpRequestTracing()` now use `SpanKind.INTERNAL`.

**Future consideration**: SpanKind for root spans should evolve with transport:

| Transport | SpanKind | Rationale |
|-----------|----------|-----------|
| CLI (local) | `INTERNAL` | Processing local input |
| MCP stdio (IPC) | `INTERNAL` | Inter-process communication via pipes |
| HTTP/gRPC (network) | `SERVER` | Handling incoming network request |

If cluster-whisperer adds an HTTP API in the future, that request-handling span should use `SERVER`. Tool execution spans nested inside would remain `INTERNAL`.

### 2. GenAI Semconv Attributes ✅ Added (MCP Mode)

Per [OTel GenAI Semantic Conventions v1.37+](https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-spans/), tool execution spans should have:

| Attribute | Status | Required Value |
|-----------|--------|----------------|
| `gen_ai.operation.name` | ✅ Added | `"execute_tool"` |
| `gen_ai.tool.name` | ✅ Added | Tool name (e.g., `"kubectl_get"`) |
| `gen_ai.tool.type` | ✅ Added | `"function"` |
| `gen_ai.tool.call.id` | ✅ Added | Unique UUID per invocation |

**Why this matters**: Datadog LLM Observability [natively supports GenAI semconv v1.37+](https://www.datadoghq.com/blog/llm-otel-semantic-convention/) and automatically maps these attributes to LLM Observability features.

**Current state**: MCP mode (`withMcpRequestTracing()`) includes GenAI tool execution attributes alongside OpenLLMetry `traceloop.*` attributes. CLI mode does not include GenAI tool execution attributes because the root span is human-invoked, not AI-invoked. (Note: CLI mode *does* set `gen_ai.system`, `gen_ai.operation.name`, and `gen_ai.request.model` on the root span — these are needed for Datadog to render the CONTENT column.)

**Status**: Fixed in PRD #15 Milestone 2. MCP root spans now include all GenAI semconv attributes for proper Datadog LLM Observability integration.

### 3. OpenLLMetry-Specific Attributes ✓ KEEP

**What we use**: `traceloop.span.kind`, `traceloop.entity.name`, `traceloop.entity.input`, `traceloop.entity.output`

**Official status**: These are OpenLLMetry/Traceloop proprietary conventions, not official OTel semconv.

**Portability**:
- Work with Datadog LLM Observability (partial - CONTENT column has issues)
- Work with Traceloop platform
- Generic OTel backends see them as custom attributes

**Recommendation**: Keep - OpenLLMetry is our LLM instrumentation library, and removing these would break integration with its ecosystem.

### 4. Custom Attributes Without Semconv Equivalent ✓ KEEP

All custom attributes use the `cluster_whisperer.*` namespace to avoid conflicts with future OTel conventions. See `telemetry/registry/attributes.yaml` for the complete list with descriptions.

**Why custom namespace**: These attributes have no OTel semantic convention equivalent. The `cluster_whisperer.*` prefix ensures they won't conflict if OTel adds similar conventions in the future.

**Recommendation**: Keep - they provide genuine value with no standard alternative.

---

## Quick Reference

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `OTEL_TRACING_ENABLED` | `false` | Enable tracing |
| `OTEL_CAPTURE_AI_PAYLOADS` | `false` | Capture sensitive content |
| `OTEL_EXPORTER_TYPE` | `console` | `console` or `otlp` |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | - | OTLP collector URL |

### Files

| File | Purpose |
|------|---------|
| `src/tracing/index.ts` | OTel initialization, exporter setup, SpanProcessor registration |
| `src/tracing/context-bridge.ts` | AsyncLocalStorage context bridging |
| `src/tracing/tool-tracing.ts` | Tool span wrapper |
| `src/tracing/tool-definitions-processor.ts` | Adds tool definitions to LLM spans |
| `src/tracing/vercel-span-processor.ts` | Enriches Vercel SDK spans for Datadog LLM Obs |
| `src/utils/kubectl.ts` | Subprocess execution with spans |

### Span Summary

| Span | Kind | Agent | Key Attributes |
|------|------|-------|----------------|
| `cluster-whisperer.cli.investigate` | INTERNAL | Both | `traceloop.span.kind=workflow`, `cluster_whisperer.agent.framework` |
| `cluster-whisperer.mcp.<tool>` | INTERNAL | N/A | `traceloop.span.kind=workflow`, `cluster_whisperer.mcp.tool.name` |
| `anthropic.chat` | INTERNAL | LangGraph | `gen_ai.system`, `gen_ai.request.model`, `gen_ai.usage.*` |
| `vercel.agent` | INTERNAL | Vercel | `ai.operationId=ai.streamText`, `gen_ai.operation.name=invoke_agent` |
| `text.stream` | INTERNAL | Vercel | `ai.operationId=ai.streamText.doStream`, `gen_ai.request.model`, `gen_ai.usage.*` |
| `<tool>.tool` | INTERNAL | Both | `traceloop.span.kind=tool`, `gen_ai.tool.name` |
| `cluster-whisperer-investigate` | INTERNAL | Vercel | `ai.operationId=ai.toolCall` (SDK tool span) |
| `kubectl {op} {resource}` | CLIENT | Both | `process.*`, `cluster_whisperer.k8s.namespace` |

For the complete attribute reference, see [`docs/telemetry-generated/attributes/cluster-whisperer.md`](telemetry-generated/attributes/cluster-whisperer.md).
