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
├── [Span: execute_tool kubectl_get]
│   └── [Span: kubectl get pods]
├── [Span: execute_tool kubectl_describe]
│   └── [Span: kubectl describe pod my-app-xyz]
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
src/tracing/index.ts        → OTel SDK initialization
src/tracing/tool-tracing.ts → MCP tool instrumentation wrapper
src/utils/kubectl.ts        → kubectl subprocess instrumentation
src/index.ts                → CLI entry point (imports tracing first)
src/mcp-server.ts           → MCP entry point (imports tracing first)
```

Tracing is imported before anything else to ensure the tracer provider is registered before any instrumented code runs.

### Configuration

Tracing is **opt-in** - disabled by default for quiet development.

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `OTEL_TRACING_ENABLED` | `false` | Set to `true` to enable tracing |

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
[OTel] Tracing enabled for cluster-whisperer v0.1.0

{
  traceId: '72f337f6c9f9631835e0731d77e22d17',
  name: 'execute_tool kubectl_get',
  kind: 0,
  duration: 80259.75,
  attributes: {
    'gen_ai.tool.name': 'kubectl_get',
    'gen_ai.tool.input': '{\n  "resource": "pods"\n}',
    'gen_ai.tool.call.arguments': '{\n  "resource": "pods"\n}',
    'gen_ai.tool.duration_ms': 80,
    'gen_ai.tool.success': true
  },
  status: { code: 1 }
}
```

Note: `kind: 0` is INTERNAL, `status.code: 1` is OK.

## What Gets Traced

| Operation | Span Name | Status |
|-----------|-----------|--------|
| MCP tool invocation | `execute_tool {tool_name}` | ✅ Implemented (M3) |
| kubectl subprocess | `kubectl {operation} {resource}` | ✅ Implemented (M4) |

### MCP Tool Spans (M3)

When an MCP tool is called, a span is created with these attributes:

| Attribute | Source | Description |
|-----------|--------|-------------|
| `gen_ai.tool.name` | Both | Tool name (e.g., `kubectl_get`) |
| `gen_ai.tool.input` | Viktor | JSON stringified input arguments |
| `gen_ai.tool.call.arguments` | Semconv | JSON stringified input arguments |
| `gen_ai.tool.duration_ms` | Viktor | Execution time in milliseconds |
| `gen_ai.tool.success` | Viktor | `true` if tool succeeded |

**Why duplicate attributes?** We include both Viktor's attribute names and OTel semantic conventions. This enables head-to-head comparison queries for the KubeCon demo while maintaining standards compliance.

**Error handling:**
- If kubectl fails (non-zero exit): `gen_ai.tool.success: false`, span status stays OK (the tool worked, kubectl failed)
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
| `k8s.client` | Viktor | Always `kubectl` |
| `k8s.operation` | Viktor | `get`, `describe`, `logs` |
| `k8s.resource` | Viktor | Resource type or pod name |
| `k8s.namespace` | Viktor | Namespace (if specified via `-n`) |
| `k8s.args` | Viktor | Full args joined: `get pods -n default` |
| `k8s.duration_ms` | Viktor | Execution time in milliseconds |
| `process.executable.name` | Semconv | Always `kubectl` |
| `process.command_args` | Semconv | Full command array: `["kubectl", "get", "pods"]` |
| `process.exit.code` | Semconv | Exit code (`0` = success) |
| `error.type` | Semconv | Set on non-zero exit (e.g., `KubectlError`) |

**Error handling:**
- Non-zero exit code: `error.type` set, span status is ERROR with stderr message
- Spawn error (kubectl not found): exception recorded, span status is ERROR
- Success: span status is OK

**Example console output:**

```
{
  traceId: 'aee9aa49429300043da06fa36b467828',
  parentSpanContext: { spanId: '64656e98ee0b505c' },  // Parent MCP tool span
  name: 'kubectl get namespaces',
  kind: 2,  // CLIENT
  attributes: {
    'k8s.client': 'kubectl',
    'k8s.operation': 'get',
    'k8s.resource': 'namespaces',
    'k8s.args': 'get namespaces',
    'k8s.duration_ms': 312,
    'process.executable.name': 'kubectl',
    'process.command_args': ['kubectl', 'get', 'namespaces'],
    'process.exit.code': 0
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

## Future: OTLP Export

M5 will add OTLP export for sending traces to backends like Datadog. The exporter configuration will be:

| Environment Variable | Description |
|---------------------|-------------|
| `OTEL_EXPORTER_TYPE` | `console` (default) or `otlp` |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | OTLP collector endpoint |

## Further Reading

- [OpenTelemetry Concepts](https://opentelemetry.io/docs/concepts/)
- [OTel JavaScript Documentation](https://opentelemetry.io/docs/languages/js/)
- [Semantic Conventions](https://opentelemetry.io/docs/specs/semconv/)
- [`docs/opentelemetry-research.md`](./opentelemetry-research.md) - Detailed research findings
