# OpenTelemetry in cluster-whisperer

This document explains how observability works in cluster-whisperer using OpenTelemetry.

## What is OpenTelemetry?

OpenTelemetry (OTel) is an open standard for collecting observability data: traces, metrics, and logs. Think of it as a universal language for "what happened in my application."

**Why use OTel instead of a specific vendor's SDK?**
- Write instrumentation once, send data anywhere
- Switch backends (Datadog, Jaeger, Honeycomb) without code changes
- Industry standard with broad ecosystem support

## Core Concepts

### Traces

A **trace** represents a complete operation from start to finish. In cluster-whisperer, a trace might be "answering the question: why is my pod crashing?"

Traces are made up of spans.

### Spans

A **span** represents a single unit of work within a trace. Spans can be nested to show parent-child relationships.

Example trace structure:
```
[Trace: "Why is my pod crashing?"]
├── [Span: anthropic.chat]                          ← LLM call (from OpenLLMetry)
│   ├── [Span: execute_tool kubectl_get]            ← Tool execution
│   │   └── [Span: kubectl get pods]                ← kubectl subprocess
│   └── [Span: execute_tool kubectl_describe]
│       └── [Span: kubectl describe pod my-app-xyz]
└── [Span: anthropic.chat]                          ← Second LLM call (with tool results)
    └── [Span: execute_tool kubectl_logs]
        └── [Span: kubectl logs my-app-xyz --previous]
```

Each span has:
- **Name**: What operation this represents
- **Start/end time**: Duration tracking
- **Attributes**: Key-value metadata (tool name, arguments, results)
- **Status**: OK or ERROR
- **Events**: Timestamped annotations (like exceptions)

### Span Kinds

Spans have a "kind" that describes their role:

| Kind | When to Use |
|------|-------------|
| `INTERNAL` | Business logic, tool execution |
| `CLIENT` | Outbound calls (kubectl subprocess, API calls) |
| `SERVER` | Handling incoming requests |

In cluster-whisperer:
- MCP tool calls are `INTERNAL` spans
- kubectl subprocess calls are `CLIENT` spans

### Attributes

Attributes are key-value pairs attached to spans. They follow semantic conventions - standardized names so tools understand them.

Example attributes on a kubectl span:
```typescript
{
  "process.executable.name": "kubectl",
  "process.command_args": ["kubectl", "get", "pods", "-n", "default"],
  "process.exit.code": 0
}
```

## Our Setup

### Architecture

```
src/tracing/index.ts        → OpenLLMetry initialization (owns TracerProvider)
src/tracing/tool-tracing.ts → Tool instrumentation using OpenLLMetry's withTool
src/utils/kubectl.ts        → kubectl subprocess instrumentation
src/index.ts                → CLI entry point (imports tracing first)
src/mcp-server.ts           → MCP entry point (imports tracing first)
```

Tracing is imported before anything else to ensure:
1. OpenLLMetry registers the global TracerProvider
2. LangChain/Anthropic are instrumented before they're imported

### Why OpenLLMetry Owns the TracerProvider

OpenTelemetry has a single global TracerProvider. If multiple libraries try to create their own, spans don't correlate properly - they end up in separate traces or get lost entirely.

**The problem we avoided:**
```typescript
// ❌ BAD: Creates TWO TracerProviders - spans won't correlate
const sdk = new NodeSDK({ ... });  // Creates TracerProvider #1
sdk.start();
traceloop.initialize({ ... });      // Creates TracerProvider #2 internally
```

**Our solution:**
```typescript
// ✅ GOOD: Single TracerProvider owned by OpenLLMetry
traceloop.initialize({
  exporter: ourCustomExporter,  // OpenLLMetry uses our exporter
  // ... other options
});
// OpenLLMetry creates the only TracerProvider
```

This is the [officially recommended pattern](https://opentelemetry.io/docs/languages/js/instrumentation/) - let one library own the TracerProvider and pass configuration to it.

### Integrating Custom Spans with OpenLLMetry

OpenLLMetry provides official wrappers for creating spans that properly integrate with auto-instrumented LLM spans:

**For tool calls:**
```typescript
import * as traceloop from "@traceloop/node-server-sdk";

// Creates a span that's properly parented under the LLM span
const result = await traceloop.withTool(
  { name: "kubectl_get" },
  async () => {
    // Tool logic here - nested spans become children
    return executeKubectl(["get", "pods"]);
  }
);
```

**For workflows:**
```typescript
await traceloop.withWorkflow(
  { name: "investigate-pod-failure" },
  async () => {
    // Workflow logic
  }
);
```

**Getting the tracer for lower-level spans:**
```typescript
// For kubectl subprocess spans, we use OpenLLMetry's tracer
const tracer = traceloop.getTraceloopTracer();

tracer.startActiveSpan("kubectl get pods", { kind: SpanKind.CLIENT }, (span) => {
  // This span is properly parented under the active withTool span
});
```

### Why Use OpenLLMetry's Wrappers?

1. **Proper parent-child relationships**: Spans created with `withTool` are automatically parented under the active LLM span from OpenLLMetry's auto-instrumentation

2. **Consistent trace context**: Using `getTraceloopTracer()` ensures our custom spans use the same TracerProvider as auto-instrumented spans

3. **Future compatibility**: As OpenLLMetry evolves, using their official APIs means we get improvements automatically

### The Complete Span Hierarchy

With this architecture, a full investigation produces this trace:

```text
CompiledStateGraph.workflow (OpenLLMetry - LangGraph auto)
└── anthropic.chat (OpenLLMetry - LLM auto)
    └── kubectl_get (our withTool wrapper)
        └── kubectl get pods (our subprocess span)
└── anthropic.chat (OpenLLMetry - LLM auto)
    └── kubectl_describe (our withTool wrapper)
        └── kubectl describe pod broken-pod (our subprocess span)
```

All spans share the same trace ID and have proper parent-child relationships because they all use the same TracerProvider.

### Configuration

Tracing is **opt-in** - disabled by default for quiet development.

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `OTEL_TRACING_ENABLED` | `false` | Set to `true` to enable tracing |
| `OTEL_CAPTURE_AI_PAYLOADS` | `false` | Set to `true` to capture prompts/completions (security: opt-in) |

### Enabling Tracing

```bash
# Enable tracing for a single run
OTEL_TRACING_ENABLED=true vals exec -i -f .vals.yaml -- node dist/index.js "what pods are running?"

# Or export for the session
export OTEL_TRACING_ENABLED=true
vals exec -i -f .vals.yaml -- node dist/index.js "what pods are running?"
```

### Console Output

With tracing enabled, you'll see spans printed to the console:

```
[OTel] Initializing OpenTelemetry tracing...
[OTel] Using console exporter
[OTel] Tracing enabled for cluster-whisperer v0.1.0
[OTel] OpenLLMetry initialized for LLM instrumentation

{
  traceId: '72f337f6c9f9631835e0731d77e22d17',
  name: 'execute_tool kubectl_get',
  kind: 0,
  duration: 80259.75,
  attributes: {
    'gen_ai.operation.name': 'execute_tool',
    'gen_ai.tool.name': 'kubectl_get',
    'gen_ai.tool.type': 'function',
    'gen_ai.tool.call.id': 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    'gen_ai.tool.call.arguments': '{\n  "resource": "pods"\n}'
  },
  status: { code: 1 }
}
```

Note: `kind: 0` is INTERNAL, `status.code: 1` is OK.

## What Gets Traced

| Operation | Span Name | Status |
|-----------|-----------|--------|
| LLM calls | `anthropic.chat` | ✅ Auto-instrumented by OpenLLMetry |
| MCP tool invocation | `execute_tool {tool_name}` | ✅ Implemented |
| kubectl subprocess | `kubectl {operation} {resource}` | ✅ Implemented |

### LLM Call Spans (OpenLLMetry)

[OpenLLMetry](https://github.com/traceloop/openllmetry-js) (`@traceloop/node-server-sdk` v0.22.6+) automatically instruments LangChain and Anthropic SDK calls. When the agent reasons and makes decisions, spans are created with:

| Attribute | Description |
|-----------|-------------|
| `gen_ai.system` | Provider name (`Anthropic`) |
| `gen_ai.request.model` | Model requested (`claude-sonnet-4-20250514`) |
| `gen_ai.response.model` | Model used in response |
| `gen_ai.usage.prompt_tokens` | Input token count |
| `gen_ai.usage.completion_tokens` | Output token count |
| `llm.usage.total_tokens` | Total tokens used |

**Privacy note:** Content capture (prompts, completions, user questions) is **disabled by default** for security. To enable it for development/debugging with non-sensitive data:

```bash
# Enable content capture (default: disabled for security)
export OTEL_CAPTURE_AI_PAYLOADS=true
```

This controls both OpenLLMetry's content capture and our custom span attributes (`user.question`, `traceloop.entity.input/output`).

**Example LLM span:**
```text
{
  name: 'anthropic.chat',
  attributes: {
    'gen_ai.system': 'Anthropic',
    'gen_ai.request.model': 'claude-sonnet-4-20250514',
    'gen_ai.usage.prompt_tokens': 1669,
    'gen_ai.usage.completion_tokens': 137,
    'llm.usage.total_tokens': 1806
  }
}
```

### MCP Tool Spans (M3)

When an MCP tool is called, a span is created with these attributes:

| Attribute | Required? | Description |
|-----------|-----------|-------------|
| `gen_ai.operation.name` | Required | Always `"execute_tool"` |
| `gen_ai.tool.name` | Required | Tool name (e.g., `kubectl_get`) |
| `gen_ai.tool.type` | Recommended | Always `"function"` |
| `gen_ai.tool.call.id` | Recommended | Unique UUID per invocation |
| `gen_ai.tool.call.arguments` | Required | JSON stringified input arguments |

These attributes follow [OTel GenAI semantic conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/) for compatibility with Datadog LLM Observability and other OTel-compatible tools.

**Error handling:**
- If kubectl fails (non-zero exit): span status stays OK (the tool worked, kubectl failed)
- If an exception is thrown: span records the exception and sets status to ERROR

### kubectl Subprocess Spans (M4)

When kubectl is executed, a child span is created under the MCP tool span:

```
execute_tool kubectl_get (INTERNAL)
└── kubectl get pods (CLIENT)
```

**Span configuration:**
- **Name**: `kubectl {operation} {resource}` (e.g., `kubectl get pods`)
- **Kind**: `CLIENT` (outbound subprocess call)
- **Parent**: Automatically parented under the active MCP tool span

**Attributes captured:**

| Attribute | Source | Description |
|-----------|--------|-------------|
| `process.executable.name` | Semconv | Always `kubectl` |
| `process.command_args` | Semconv | Full command array: `["kubectl", "get", "pods"]` |
| `process.exit.code` | Semconv | Exit code (`0` = success) |
| `error.type` | Semconv | Set on non-zero exit (e.g., `KubectlError`) |
| `k8s.namespace` | Custom | Namespace if specified via `-n` (useful for filtering) |
| `k8s.output_size_bytes` | Custom | Output size in bytes (useful for debugging large responses) |

Note: We keep `k8s.namespace` and `k8s.output_size_bytes` as pragmatic custom attributes because they have no semconv equivalent and provide genuine value for Kubernetes-specific queries and debugging.

**Error handling:**
- Non-zero exit code: `error.type` set, span status is ERROR with stderr message
- Spawn error (kubectl not found): exception recorded, span status is ERROR
- Success: span status is OK

**Example console output:**

```
{
  traceId: 'aee9aa49429300043da06fa36b467828',
  parentSpanContext: { spanId: '64656e98ee0b505c' },  // Parent MCP tool span
  name: 'kubectl get pods',
  kind: 2,  // CLIENT
  attributes: {
    'process.executable.name': 'kubectl',
    'process.command_args': ['kubectl', 'get', 'pods', '-n', 'default'],
    'process.exit.code': 0,
    'k8s.namespace': 'default',
    'k8s.output_size_bytes': 1024
  },
  status: { code: 1 }  // OK
}
```

## When Tracing is Disabled

When `OTEL_TRACING_ENABLED` is not `true`, the OTel API returns a "no-op" tracer. This means:
- All tracing calls (`getTracer()`, `startActiveSpan()`) are safe to call
- They do nothing - zero performance overhead
- No console output, no span creation

This design lets us leave instrumentation code in place without conditional checks everywhere.

## OTLP Export

Traces can be sent to any OTLP-compatible backend (Datadog, Jaeger, etc.) by configuring the exporter.

### Configuration

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `OTEL_TRACING_ENABLED` | `false` | Set to `true` to enable tracing |
| `OTEL_EXPORTER_TYPE` | `console` | `console` for stdout, `otlp` for OTLP export |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | - | OTLP collector URL (required when type=otlp) |
| `OTEL_CAPTURE_AI_PAYLOADS` | `false` | Set to `true` to capture prompts/completions (security: opt-in) |

### Using Console Exporter (Development)

```bash
OTEL_TRACING_ENABLED=true \
vals exec -i -f .vals.yaml -- node dist/index.js "what pods are running?"
```

### Using OTLP Exporter (Production)

```bash
OTEL_TRACING_ENABLED=true \
OTEL_EXPORTER_TYPE=otlp \
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 \
vals exec -i -f .vals.yaml -- node dist/index.js "what pods are running?"
```

### Datadog Setup

#### Local Datadog Agent (Recommended)

If you have the Datadog Agent running locally on your machine, it can receive OTLP traces directly on `localhost:4318`. This is the simplest setup - no port-forwarding required.

```bash
# Verify the local agent is listening
curl -s http://localhost:4318/v1/traces -X POST -H "Content-Type: application/json" -d '{}'
# Any response (200, 400, 415) means the agent is reachable
# "Connection refused" means the agent isn't running or OTLP isn't enabled
```

The local agent configuration at `/opt/datadog-agent/etc/datadog.yaml` should have:

```yaml
otlp_config:
  receiver:
    protocols:
      http:
        endpoint: 0.0.0.0:4318
```

#### In-Cluster Datadog Agent (Alternative)

If you need to run the Datadog Agent in a Kubernetes cluster instead, install with OTLP receiver enabled:

```bash
# Add Datadog helm repo
helm repo add datadog https://helm.datadoghq.com
helm repo update

# Create values file with OTLP enabled
cat > /tmp/datadog-values.yaml << 'EOF'
datadog:
  site: datadoghq.com
  otlp:
    receiver:
      protocols:
        http:
          enabled: true
  kubelet:
    host:
      valueFrom:
        fieldRef:
          fieldPath: status.hostIP
  env:
    - name: DD_HOSTNAME
      valueFrom:
        fieldRef:
          fieldPath: spec.nodeName
EOF

# Install (replace $DD_API_KEY with your key)
helm install datadog datadog/datadog \
  --set datadog.apiKey=$DD_API_KEY \
  -f /tmp/datadog-values.yaml
```

To send traces from a local cluster-whisperer to an in-cluster agent, port-forward:

```bash
kubectl port-forward svc/datadog 4318:4318
```

View traces at: <https://app.datadoghq.com/apm/traces?query=service%3Acluster-whisperer>

### Datadog LLM Observability

Traces also appear in Datadog LLM Observability with full feature support:
- Token usage tracking
- Cost estimation (calculated from token counts + model pricing)
- LLM call counts
- Model/provider grouping

View LLM traces at: <https://app.datadoghq.com/llm/traces?query=%40ml_app%3Acluster-whisperer>

#### CONTENT Column (Fixed)

The Datadog LLM Observability CONTENT column now displays clean INPUT and OUTPUT text for cluster-whisperer traces in both CLI and MCP modes.

**How it works**: We manually set `gen_ai.input.messages` and `gen_ai.output.messages` as JSON-stringified span attributes on root spans using the OTel v1.37+ `parts` format. This works around OpenLLMetry-JS still using the deprecated `gen_ai.prompt.N` / `gen_ai.completion.N` format.

**Format** (set in `src/tracing/context-bridge.ts`):
```json
// gen_ai.input.messages
[{"role": "user", "parts": [{"type": "text", "content": "Find the broken pod..."}]}]

// gen_ai.output.messages
[{"role": "assistant", "parts": [{"type": "text", "content": "The pod is failing..."}], "finish_reason": "end_turn"}]
```

**Key details**:
- Both attributes are content-gated behind `OTEL_CAPTURE_AI_PAYLOADS=true`
- Root spans also need `gen_ai.system`, `gen_ai.operation.name`, and `gen_ai.request.model` for Datadog to recognize them as LLM call spans
- `gen_ai.completion.0.content` on `chat.anthropic` spans remains empty due to an OpenLLMetry-JS bug with extended thinking ([traceloop/openllmetry-js#671](https://github.com/traceloop/openllmetry-js/pull/671)) — our manual attributes bypass this

**Upstream tracking**: [traceloop/openllmetry#3515](https://github.com/traceloop/openllmetry/issues/3515) — when OpenLLMetry-JS adopts the v1.37+ format natively, our manual workaround can be removed.

**Full details**: See PRD #21 and `docs/research/21-content-column-research.md`.

### Jaeger Setup

Jaeger also accepts OTLP on port 4318. The same endpoint configuration works:

```bash
# Deploy Jaeger (example using all-in-one for development)
kubectl apply -f https://raw.githubusercontent.com/jaegertracing/jaeger-operator/main/examples/simplest.yaml

# Port-forward to access
kubectl port-forward svc/jaeger-collector 4318:4318

# Run with OTLP export
OTEL_TRACING_ENABLED=true \
OTEL_EXPORTER_TYPE=otlp \
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 \
vals exec -i -f .vals.yaml -- node dist/index.js "what pods are running?"
```

### Backend-Agnostic Design

The same code works with any OTLP-compatible backend. Only the endpoint changes:

| Backend | Endpoint Example |
|---------|------------------|
| Datadog Agent (local) | `http://localhost:4318` |
| Datadog Agent (in-cluster via port-forward) | `http://localhost:4318` |
| Jaeger (local) | `http://localhost:4318` |
| Jaeger (in-cluster via port-forward) | `http://localhost:4318` |

For KubeCon demo, audience vote determines which backend to use - just change which agent is running locally or which port-forward is active.

## Async Context Propagation

For proper parent-child span relationships across async boundaries, we use `context.with()` in `tool-tracing.ts`:

```typescript
const span = tracer.startSpan(`execute_tool ${toolName}`, { kind: SpanKind.INTERNAL });
const activeContext = trace.setSpan(context.active(), span);

return context.with(activeContext, async () => {
  // Nested spans (like kubectl) automatically become children
  const result = await handler(input);
  // ...
});
```

This ensures kubectl spans are correctly parented under MCP tool spans, creating the expected hierarchy:

```
execute_tool kubectl_get (INTERNAL, 294ms)
└── kubectl get pods (CLIENT, 293ms)
```

## LangGraph Context Bridge (Workaround)

**Problem:** LangGraph breaks Node.js async context propagation. When OpenLLMetry creates spans for LLM calls and we create tool spans inside LangGraph's execution, the tool spans end up orphaned in separate traces instead of nesting under the workflow span.

**Root cause:** LangGraph's internal async execution model loses the OpenTelemetry context that's normally propagated through Node.js's `AsyncLocalStorage`. The same issue occurred in the Python SDK and was fixed in [PR #3206](https://github.com/traceloop/openllmetry/pull/3206).

**Upstream issue:** [traceloop/openllmetry-js#476](https://github.com/traceloop/openllmetry-js/issues/476)

**Our workaround:** `src/tracing/context-bridge.ts` uses explicit `AsyncLocalStorage` to bridge the context gap:

```typescript
// context-bridge.ts creates its own AsyncLocalStorage to preserve context
const contextStorage = new AsyncLocalStorage<Context>();

// withAgentTracing() stores the context before LangGraph runs
export async function withAgentTracing<T>(question: string, fn: () => Promise<T>): Promise<T> {
  return tracer.startActiveSpan("cluster-whisperer.investigate", async (span) => {
    const currentContext = trace.setSpan(context.active(), span);
    // Store context in our AsyncLocalStorage before LangGraph loses it
    return contextStorage.run(currentContext, fn);
  });
}

// withStoredContext() retrieves it when creating tool spans
export function withStoredContext<T>(fn: () => T): T {
  const storedCtx = contextStorage.getStore() ?? context.active();
  return context.with(storedCtx, fn);
}
```

**How it's used:**

1. `src/index.ts` wraps the agent invocation with `withAgentTracing(question, ...)`
2. `src/tracing/tool-tracing.ts` uses `withStoredContext()` when creating tool spans
3. Tool spans now correctly nest under the workflow span

**When to remove:** Check [issue #476](https://github.com/traceloop/openllmetry-js/issues/476) periodically. When OpenLLMetry-JS adds native LangGraph support, this workaround can be removed:
1. Delete `src/tracing/context-bridge.ts`
2. Update `src/index.ts` to remove `withAgentTracing` wrapper
3. Update `src/tracing/tool-tracing.ts` to remove `withStoredContext` usage

## Why OpenLLMetry?

### What is OpenLLMetry?

[OpenLLMetry](https://github.com/traceloop/openllmetry) is a library that automatically instruments LLM calls using OpenTelemetry. It's built by [Traceloop](https://traceloop.com) and released under Apache 2.0.

**OpenTelemetry** is the standard for observability - it defines *how* to describe events (spans, traces, attributes) but doesn't know anything specific about LLMs.

**OpenLLMetry** fills the gap by:
- Monkey-patching LangChain and Anthropic SDKs to capture LLM calls automatically
- Creating spans with proper GenAI semantic conventions (`gen_ai.usage.input_tokens`, etc.)
- Maintaining compatibility as those SDKs update

### Why not just use the OTel SDK directly?

OpenTelemetry is layered:

| Layer | What it provides | Status |
|-------|------------------|--------|
| **Core SDK** | Span creation, context propagation, exporters | ✅ Exists |
| **Semantic Conventions** | Attribute names like `gen_ai.usage.input_tokens` | ✅ Exists (GenAI semconv stable) |
| **Instrumentation Libraries** | Code that hooks into LangChain/Anthropic/OpenAI | ⏳ In progress |

The OTel project provides the SDK and conventions, but **instrumentation libraries are contributed separately**. There's an `opentelemetry-js-contrib` repo with instrumentations for Express, PostgreSQL, Redis, etc. - but official LLM instrumentations for JavaScript don't exist yet.

### OpenTelemetry GenAI SIG

The [OpenTelemetry GenAI Special Interest Group](https://opentelemetry.io/blog/2024/otel-generative-ai/) (started April 2024) is working to standardize LLM observability:

- **Semantic conventions**: Now stable - attribute names, types, enum values for LLM calls
- **Instrumentation libraries**: In development - Python first, JavaScript TBD

OpenLLMetry's semantic conventions have been [incorporated into official OTel semconv](https://horovits.medium.com/opentelemetry-for-genai-and-the-openllmetry-project-81b9cea6a771). Traceloop is working to donate the instrumentation code to OpenTelemetry.

### Roadmap and Timeline

The [GenAI project milestones](https://github.com/open-telemetry/community/blob/main/projects/gen-ai.md):

| Milestone | Goal | Status |
|-----------|------|--------|
| **M1** | Ship OpenAI instrumentation for Python and JS | Python: in progress, JS: TBD |
| **M2** | Instrumentations for orchestrators/frameworks (LangChain, etc.) | Future |
| **M3** | Propose instrumentations to upstream libraries | Future |

**No specific dates are published.** Python is the priority; JavaScript timeline is undefined.

### What this means for cluster-whisperer

For now, OpenLLMetry (`@traceloop/node-server-sdk`) is our best option for automatic LLM instrumentation in Node.js. When official OTel instrumentation becomes available:

1. Switch from `@traceloop/node-server-sdk` to official `@opentelemetry/instrumentation-*` packages
2. The code would be maintained by the OTel community instead of one company
3. Our upstream issues would be tracked in OTel repos

### Known limitations

We track two upstream issues:

| Issue | Problem | Impact |
|-------|---------|--------|
| [traceloop/openllmetry-js#476](https://github.com/traceloop/openllmetry-js/issues/476) | LangGraph breaks async context propagation | We use `context-bridge.ts` as workaround |
| [traceloop/openllmetry#3515](https://github.com/traceloop/openllmetry/issues/3515) | Old semconv format for content attributes | `gen_ai.completion.0.content` is empty with extended thinking — **workaround in place** via `gen_ai.output.messages` (PRD #21) |

## Further Reading

- [OpenTelemetry Concepts](https://opentelemetry.io/docs/concepts/)
- [OTel JavaScript Documentation](https://opentelemetry.io/docs/languages/js/)
- [Semantic Conventions](https://opentelemetry.io/docs/specs/semconv/)
- [GenAI Semantic Conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/)
- [OpenTelemetry GenAI SIG](https://github.com/open-telemetry/community/blob/main/projects/gen-ai.md)
- [OpenLLMetry Documentation](https://www.traceloop.com/docs/openllmetry/introduction) - LLM observability
- [OpenLLMetry Privacy Settings](https://www.traceloop.com/docs/openllmetry/privacy/traces) - Disabling content tracing
- [`docs/opentelemetry-research.md`](./opentelemetry-research.md) - Detailed research findings
