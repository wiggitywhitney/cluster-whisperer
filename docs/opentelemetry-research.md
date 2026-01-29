# OpenTelemetry Research

**PRD**: #6 - OpenTelemetry Instrumentation
**Date**: 2026-01-27
**Updated**: 2026-01-28 (Sections 7-10 added for PRD #11)
**Status**: Active Research Document

---

## Table of Contents

1. [OpenTelemetry JS SDK](#1-opentelemetry-js-sdk)
2. [Semantic Conventions](#2-semantic-conventions)
3. [OpenTelemetry Weaver](#3-opentelemetry-weaver)
4. [Viktor's Implementation](#4-viktors-implementation)
5. [Datadog OTLP Ingestion](#5-datadog-otlp-ingestion)
6. [Implementation Decisions (PRD #6)](#6-implementation-decisions)
7. [OpenLLMetry](#7-openllmetry)
8. [Claude Code Built-in Telemetry](#8-claude-code-built-in-telemetry)
9. [Datadog GenAI Semantic Conventions](#9-datadog-genai-semantic-conventions)
10. [Semconv Gap Analysis](#10-semconv-gap-analysis)

---

## 1. OpenTelemetry JS SDK

### Current Packages (SDK 2.0, June 2025)

**Runtime requirements:**
- Node.js: `^18.19.0 || >=20.6.0`
- TypeScript: 5.0.4 minimum

**Core packages for tracing:**

| Package | Purpose |
|---------|---------|
| `@opentelemetry/api` | Core API (tracers, spans, context) |
| `@opentelemetry/sdk-node` | Full SDK for Node.js |
| `@opentelemetry/sdk-trace-node` | Trace-specific SDK components |
| `@opentelemetry/resources` | Resource configuration |
| `@opentelemetry/semantic-conventions` | Standardized attribute names |
| `@opentelemetry/exporter-trace-otlp-proto` | OTLP exporter (HTTP/protobuf) |

**Installation:**
```bash
npm install @opentelemetry/sdk-node \
  @opentelemetry/api \
  @opentelemetry/sdk-trace-node \
  @opentelemetry/exporter-trace-otlp-proto \
  @opentelemetry/resources \
  @opentelemetry/semantic-conventions
```

### Setup Pattern

Create an `instrumentation.ts` that runs before your application:

```typescript
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';

const sdk = new NodeSDK({
  resource: resourceFromAttributes({
    [ATTR_SERVICE_NAME]: 'cluster-whisperer',
    [ATTR_SERVICE_VERSION]: '1.0.0',
  }),
  traceExporter: new OTLPTraceExporter({
    url: '<your-otlp-endpoint>/v1/traces',
  }),
});

sdk.start();
```

**Execution (Node.js v20+):**
```bash
npx tsx --import ./instrumentation.ts app.ts
```

### Creating Spans

**Get a tracer at point of use:**
```typescript
import { trace } from '@opentelemetry/api';

const tracer = trace.getTracer('cluster-whisperer', '1.0.0');
```

**Use `startActiveSpan` (recommended):**
```typescript
function myOperation() {
  return tracer.startActiveSpan('myOperation', (span) => {
    try {
      // Child spans automatically become children of this span
      const result = doWork();
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error) {
      span.recordException(error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
      throw error;
    } finally {
      span.end(); // Always end the span
    }
  });
}
```

### Best Practices

1. **Always end spans** - Use `finally` blocks
2. **Prefer `startActiveSpan`** - Automatically manages context for child spans
3. **Record exceptions properly** - Use `span.recordException(error)` then set status
4. **Get tracer at point of use** - Use a factory function like `getTracer()` rather than exporting a cached tracer instance (avoids initialization timing issues)

---

## 2. Semantic Conventions

### Span Naming Pattern

OpenTelemetry recommends **`{verb} {object}`** for low-cardinality span names. High-cardinality details go in attributes.

| Domain | Pattern | Example |
|--------|---------|---------|
| GenAI | `{operation} {model}` | `chat claude-3-5-sonnet` |
| Tool Execution | `execute_tool {tool_name}` | `execute_tool kubectl_get` |
| CLI/Process | `{executable}` | `kubectl` |

### GenAI Conventions (for LLM/Agent operations)

**Operation types (`gen_ai.operation.name`):**
- `chat` - Single LLM call
- `invoke_agent` - Agent invocation
- `execute_tool` - Tool execution

**Tool execution attributes:**

| Attribute | Type | Description |
|-----------|------|-------------|
| `gen_ai.tool.name` | string | Tool name (e.g., `kubectl_get`) |
| `gen_ai.tool.type` | string | `function`, `extension`, or `datastore` |
| `gen_ai.tool.call.id` | string | Unique tool call identifier |
| `gen_ai.tool.call.arguments` | string/object | Parameters passed to tool |
| `gen_ai.tool.call.result` | string/object | Result returned by tool |

**AI operation attributes:**

| Attribute | Type | Description |
|-----------|------|-------------|
| `gen_ai.operation.name` | string | Operation type |
| `gen_ai.provider.name` | string | Provider (e.g., `anthropic`) |
| `gen_ai.request.model` | string | Model name |
| `gen_ai.usage.input_tokens` | int | Input token count |
| `gen_ai.usage.output_tokens` | int | Output token count |

### Process/CLI Conventions (for kubectl subprocess)

**Span configuration:**
- Span name: `{process.executable.name}` (e.g., `kubectl`)
- Span kind: `CLIENT` (caller perspective)

**Process attributes:**

| Attribute | Type | Description |
|-----------|------|-------------|
| `process.executable.name` | string | Executable name (e.g., `kubectl`) |
| `process.command` | string | Command used to launch |
| `process.command_args` | string[] | All arguments including executable |
| `process.exit.code` | int | Exit code |
| `error.type` | string | Required when exit code != 0 |

### Error Handling

```typescript
span.recordException(error);
span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
span.setAttribute('error.type', error.constructor.name);
```

---

## 3. OpenTelemetry Weaver

### What It Is

OpenTelemetry Weaver is a CLI tool for **schema-driven observability**. It:
- Validates semantic convention schemas (YAML)
- Generates type-safe constants from schemas
- Produces documentation from schemas
- Validates live telemetry against schemas

### Assessment: NOT Applicable

**Weaver is not useful for this project because:**

1. **Constants already exist** - The `@opentelemetry/semantic-conventions` npm package provides all TypeScript constants we need. This package IS generated using Weaver.

2. **Solves enterprise-scale problems** - Designed for organizations managing custom semantic conventions across many teams/services. We're using standard OTel conventions.

3. **No custom schemas** - Weaver shines when defining/versioning organization-specific conventions. We follow standard conventions.

**What to use instead:**
```typescript
import {
  ATTR_SERVICE_NAME,
  ATTR_PROCESS_COMMAND,
  ATTR_PROCESS_COMMAND_ARGS,
} from '@opentelemetry/semantic-conventions';
```

---

## 4. Viktor's Implementation

Analysis of Viktor's `dot-ai` repository OpenTelemetry implementation.

### What He Instruments

| Operation | Wrapper Function | File |
|-----------|------------------|------|
| MCP Tool Calls | `withToolTracing()` | `src/core/tracing/tool-tracing.ts` |
| AI/LLM Operations | `withAITracing()` | `src/core/tracing/ai-tracing.ts` |
| Kubernetes API | `createTracedK8sClient()` | `src/core/tracing/k8s-tracing.ts` |
| kubectl CLI | `withKubectlTracing()` | `src/core/tracing/k8s-tracing.ts` |
| Qdrant (Vector DB) | `withQdrantTracing()` | `src/core/tracing/qdrant-tracing.ts` |

### Span Naming Conventions

| Operation Type | Span Name Pattern | Example |
|----------------|-------------------|---------|
| Tool Execution | `execute_tool {toolName}` | `execute_tool recommend` |
| AI Chat | `{operation} {model}` | `chat claude-3-5-sonnet` |
| kubectl CLI | `kubectl {operation} {resource}` | `kubectl get pods` |
| K8s API Client | `k8s.{methodName}` | `k8s.listNamespace` |

### Attribute Conventions

**Tool execution:**
```typescript
{
  'gen_ai.tool.name': toolName,
  'gen_ai.tool.input': JSON.stringify(args, null, 2),
  'gen_ai.tool.duration_ms': duration,
  'gen_ai.tool.success': true,
  'mcp.client.name': clientName,     // Custom
  'mcp.client.version': clientVersion, // Custom
}
```

**kubectl CLI:**
```typescript
{
  'k8s.client': 'kubectl',
  'k8s.command': 'kubectl',
  'k8s.operation': operation,   // 'get', 'describe', 'logs'
  'k8s.resource': resource,     // 'pods', 'deployments'
  'k8s.args': args.join(' '),
  'k8s.namespace': namespace,
  'k8s.duration_ms': duration,
  'k8s.output_size_bytes': result.length,
}
```

### Span Hierarchy

```
SERVER (HTTP entry point)
  └── INTERNAL (Tool execution: execute_tool kubectl_get)
        └── CLIENT (kubectl get pods)
```

**Span Kinds:**
- `SpanKind.SERVER` - HTTP entry points
- `SpanKind.INTERNAL` - Business logic, tool execution
- `SpanKind.CLIENT` - Outbound calls (kubectl, AI providers)

### Key Design Decisions

1. **No auto-instrumentation** - All manual via wrappers (`instrumentations: []`)
2. **Generic wrapper pattern** - Functions like `withToolTracing()` instrument at architectural boundaries
3. **Official semantic conventions** - Uses `gen_ai.*` for AI, `db.*` for vector DB
4. **Opt-in by default** - `OTEL_TRACING_ENABLED=false` default
5. **Trust no-op tracer** - When disabled, OTel returns a no-op tracer with zero overhead

### Viktor's Dependencies

> **Note**: These are Viktor's package versions from dot-ai, shown here for reference.
> Our installation uses different versions and `exporter-trace-otlp-proto` instead of
> `exporter-trace-otlp-http`. See `package.json` for our actual dependencies.

```json
{
  "@opentelemetry/api": "^1.9.0",
  "@opentelemetry/exporter-trace-otlp-http": "^0.207.0",
  "@opentelemetry/resources": "^2.2.0",
  "@opentelemetry/sdk-node": "^0.207.0",
  "@opentelemetry/sdk-trace-node": "^2.2.0",
  "@opentelemetry/semantic-conventions": "^1.37.0"
}
```

---

## 5. Datadog OTLP Ingestion

### Current Status

**Important:** Datadog's direct OTLP intake has different maturity levels:
- **Logs**: GA
- **Metrics**: GA
- **Traces**: Available for **LLM Observability only** (Preview)

For general APM traces, Datadog recommends:
1. **Datadog Agent** with OTLP ingestion enabled (recommended)
2. **OpenTelemetry Collector** with Datadog Exporter

### Datadog Agent Approach (Recommended)

The Datadog Agent (v6.32.0+/v7.32.0+) can ingest OTLP:
- **gRPC**: Port 4317
- **HTTP**: Port 4318

**Agent configuration:**
```bash
DD_OTLP_CONFIG_RECEIVER_PROTOCOLS_HTTP_ENDPOINT=0.0.0.0:4318
```

**Application configuration:**
```bash
OTEL_EXPORTER_OTLP_ENDPOINT=http://<datadog-agent>:4318
```

### Direct OTLP (LLM Observability)

For LLM traces specifically, direct intake is available:

```bash
export OTEL_EXPORTER_OTLP_TRACES_PROTOCOL="http/protobuf"
export OTEL_EXPORTER_OTLP_TRACES_ENDPOINT="https://trace.agent.datadoghq.com"
export OTEL_EXPORTER_OTLP_TRACES_HEADERS="dd-api-key=${DD_API_KEY},dd-otlp-source=datadog"
```

### Unified Service Tagging

Datadog correlates telemetry using three standard tags:

| Datadog Tag | OpenTelemetry Resource Attribute |
|-------------|----------------------------------|
| `service` | `service.name` |
| `env` | `deployment.environment.name` |
| `version` | `service.version` |

**Configuration:**
```bash
export OTEL_SERVICE_NAME="cluster-whisperer"
export OTEL_RESOURCE_ATTRIBUTES="deployment.environment.name=development,service.version=1.0.0"
```

### Site-Specific Endpoints

| Site | Domain |
|------|--------|
| US1 | `datadoghq.com` |
| US3 | `us3.datadoghq.com` |
| EU1 | `datadoghq.eu` |

---

## 6. Implementation Decisions

Based on this research, here are the decisions for PRD #6:

### Packages

```bash
npm install @opentelemetry/sdk-node \
  @opentelemetry/api \
  @opentelemetry/sdk-trace-node \
  @opentelemetry/exporter-trace-otlp-proto \
  @opentelemetry/resources \
  @opentelemetry/semantic-conventions
```

### Span Structure

| Operation | Span Name | Span Kind |
|-----------|-----------|-----------|
| MCP Tool Call | `execute_tool {tool_name}` | INTERNAL |
| kubectl Execution | `kubectl {operation} {resource}` | CLIENT |

### Attribute Strategy: Both Viktor's AND Semconv

**Decision:** Include both Viktor's attributes and OTel semantic conventions on each span.

**Rationale:**
- Viktor's attributes enable head-to-head comparison queries for KubeCon demo
- Semconv attributes ensure standards compliance and tooling compatibility
- Cost is a few extra bytes per span - acceptable tradeoff

#### MCP Tool Call Attributes

| Attribute | Source | Example |
|-----------|--------|---------|
| `gen_ai.tool.name` | Both (same) | `kubectl_get` |
| `gen_ai.tool.input` | Viktor | `{"resource": "pods"}` |
| `gen_ai.tool.call.arguments` | Semconv | `{"resource": "pods"}` |
| `gen_ai.tool.duration_ms` | Viktor | `150` |
| `gen_ai.tool.success` | Viktor | `true` |
| `gen_ai.tool.call.result` | Semconv | `(output)` |

#### kubectl Execution Attributes

| Attribute | Source | Example |
|-----------|--------|---------|
| `k8s.client` | Viktor | `kubectl` |
| `k8s.operation` | Viktor | `get` |
| `k8s.resource` | Viktor | `pods` |
| `k8s.namespace` | Viktor | `default` |
| `k8s.args` | Viktor | `get pods -n default` |
| `k8s.duration_ms` | Viktor | `85` |
| `process.executable.name` | Semconv | `kubectl` |
| `process.command_args` | Semconv | `["kubectl", "get", "pods", "-n", "default"]` |
| `process.exit.code` | Semconv | `0` |
| `error.type` | Semconv | `(on non-zero exit)` |

### Hierarchy

```
INTERNAL (execute_tool kubectl_get)
  └── CLIENT (kubectl get pods)
```

### Exporter Strategy

1. **Development**: Console exporter for visibility
2. **Production/Demo**: OTLP to Datadog Agent (not direct to Datadog endpoint)

```typescript
// Development
const traceExporter = new ConsoleSpanExporter();

// Production (Datadog Agent on localhost:4318)
const traceExporter = new OTLPTraceExporter({
  url: process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://localhost:4318/v1/traces',
});
```

**Note:** Direct OTLP to Datadog is only GA for LLM Observability traces. For general APM, use Datadog Agent with OTLP ingestion. See PRD #8 Design Decisions.

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `OTEL_TRACING_ENABLED` | `false` | Enable/disable tracing |
| `OTEL_SERVICE_NAME` | `cluster-whisperer` | Service name |
| `OTEL_EXPORTER_TYPE` | `console` | `console` or `otlp` |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | - | OTLP endpoint URL |

### Weaver

**Decision: Not using Weaver.** The `@opentelemetry/semantic-conventions` package provides all constants needed. Weaver solves organization-scale governance problems we don't have.

### Manual Instrumentation

**Decision: All manual instrumentation** (no auto-instrumentation).

Following Viktor's pattern with `instrumentations: []` in SDK config. Auto-instrumentation handles HTTP clients and database drivers, but our spans are at business logic boundaries (MCP tool calls, kubectl subprocess) which require manual wrappers.

---

## 7. OpenLLMetry

**Date Added**: 2026-01-28

OpenLLMetry is Traceloop's open-source project that extends OpenTelemetry for LLM observability.

### What It Is

OpenLLMetry provides auto-instrumentation for LLM frameworks and providers:
- Wraps LLM API calls (OpenAI, Anthropic, Cohere, etc.)
- Captures prompts, completions, token usage, latency
- Emits spans following OTel GenAI semantic conventions
- Works with any OTel-compatible backend

### JavaScript/TypeScript Package

```bash
npm install @traceloop/node-server-sdk
```

**Initialization:**
```typescript
import * as traceloop from "@traceloop/node-server-sdk";

traceloop.initialize({
  disableBatch: true, // For development
  appName: "cluster-whisperer",
});
```

### Supported Frameworks (JS/TS)

| Framework | Auto-instrumented |
|-----------|-------------------|
| OpenAI SDK | Yes |
| Anthropic SDK | Yes |
| LangChain | Yes |
| Azure OpenAI | Yes |
| Cohere | Yes |
| Bedrock | Yes |

### Why It Matters for Us

Cluster-whisperer uses LangChain which calls Anthropic's API. OpenLLMetry can automatically instrument these LLM calls, capturing:
- `gen_ai.request.model` (e.g., `claude-3-5-sonnet`)
- `gen_ai.provider.name` (e.g., `anthropic`)
- `gen_ai.usage.input_tokens` / `gen_ai.usage.output_tokens`
- `gen_ai.operation.name` (e.g., `chat`)
- Prompt and completion content (configurable)

This creates a complete trace: user question → LLM reasoning → tool calls → kubectl execution.

### LangChain Native OTel

LangChain has built-in OTel support, but **only for Python**. The JavaScript/TypeScript SDK does not have native OTel instrumentation. OpenLLMetry is the path for TypeScript projects using LangChain.

### Sources

- OpenLLMetry GitHub: <https://github.com/traceloop/openllmetry>
- Traceloop docs: <https://www.traceloop.com/docs>
- npm package: <https://www.npmjs.com/package/@traceloop/node-server-sdk>

---

## 8. Claude Code Built-in Telemetry

**Date Added**: 2026-01-28

Claude Code (Anthropic's CLI tool) has built-in OpenTelemetry instrumentation.

### Enabling Telemetry

```bash
export CLAUDE_CODE_ENABLE_TELEMETRY=1
```

### What It Captures

When enabled, Claude Code exports:
- Session metrics (duration, tool calls, token usage)
- Events for significant actions
- Performance data

### Relevance

This is interesting for understanding how Anthropic instruments their own AI tooling, but **not directly applicable** to cluster-whisperer. We control our own instrumentation.

However, if cluster-whisperer is invoked BY Claude Code (as an MCP server), Claude Code's telemetry would capture the outer context while our instrumentation captures the inner details.

---

## 9. Datadog GenAI Semantic Conventions

**Date Added**: 2026-01-28

Datadog natively supports OpenTelemetry GenAI Semantic Conventions (v1.37+).

### Supported Attributes

Datadog automatically maps these `gen_ai.*` attributes to LLM Observability features:

| Attribute | Datadog Feature |
|-----------|-----------------|
| `gen_ai.request.model` | Model identification |
| `gen_ai.provider.name` | Provider grouping |
| `gen_ai.operation.name` | Operation type tracking |
| `gen_ai.usage.input_tokens` | Token usage metrics |
| `gen_ai.usage.output_tokens` | Token usage metrics |
| `gen_ai.usage.total_tokens` | Cost analysis |

### Automatic Conversion

OpenTelemetry traces with `gen_ai.*` attributes are automatically converted to LLM Observability traces in Datadog. No code changes required once spans follow semconv.

### Configuration for Pre-1.37 Frameworks

If using a framework that emits older semconv versions:

```bash
export OTEL_SEMCONV_STABILITY_OPT_IN=gen_ai_latest_experimental
```

### Ingestion Options

1. **Datadog Agent** with OTLP receiver (recommended for APM + LLM)
2. **Direct OTLP** to Datadog intake (LLM Observability only)
3. **OTel Collector** with Datadog exporter

### Why This Matters

**Full semconv compliance unlocks Datadog LLM Observability features:**
- Token usage dashboards
- Cost tracking per model/provider
- Latency analysis by operation type
- Cross-service correlation

Viktor's custom attributes (`gen_ai.tool.input`, `gen_ai.tool.duration_ms`, `gen_ai.tool.success`, `k8s.*`) are **not recognized** by Datadog's LLM Observability. They appear as generic span attributes but don't power any features.

### Sources

- Datadog blog: <https://www.datadoghq.com/blog/llm-otel-semantic-convention/>
- Datadog docs: <https://docs.datadoghq.com/llm_observability/instrumentation/otel_instrumentation/>

---

## 10. Semconv Gap Analysis

**Date Added**: 2026-01-28

Comparison of our current implementation (PRD #6) against official OTel GenAI semantic conventions.

### Current State: Hybrid Approach

PRD #6 implemented both Viktor's custom attributes AND some semconv attributes. This was a "safe" choice for KubeCon demo comparison, but has downsides:
- Viktor's attributes don't power Datadog features
- Extra bytes per span for duplicate data
- Confusing for anyone reading the code

### MCP Tool Spans: Gap Analysis

| Semconv Attribute | Required? | Our Status |
|-------------------|-----------|------------|
| `gen_ai.operation.name` | **Yes** | ❌ Missing |
| `gen_ai.tool.name` | Yes | ✅ Present |
| `gen_ai.tool.type` | Recommended | ❌ Missing |
| `gen_ai.tool.call.id` | Recommended | ❌ Missing |
| `gen_ai.tool.call.arguments` | Yes | ✅ Present |
| `gen_ai.tool.call.result` | Recommended | ❌ Missing |

**Viktor's custom attributes (not in semconv):**
- `gen_ai.tool.input` - Duplicate of `gen_ai.tool.call.arguments`
- `gen_ai.tool.duration_ms` - Not in semconv (duration is span timing)
- `gen_ai.tool.success` - Not in semconv (use span status)

### kubectl Spans: Gap Analysis

| Semconv Attribute | Required? | Our Status |
|-------------------|-----------|------------|
| `process.executable.name` | Yes | ✅ Present |
| `process.command_args` | Yes | ✅ Present |
| `process.exit.code` | Yes | ✅ Present |
| `error.type` | When error | ✅ Present |

**Viktor's custom attributes (not in semconv):**
- `k8s.client` - Custom (redundant with `process.executable.name`)
- `k8s.operation` - Custom (could use span name)
- `k8s.resource` - Custom (could use span name)
- `k8s.namespace` - Custom (not in process semconv)
- `k8s.args` - Custom (redundant with `process.command_args`)
- `k8s.duration_ms` - Custom (duration is span timing)
- `k8s.output_size_bytes` - Custom

### Recommendation: Full Semconv Embrace

**Remove Viktor's custom attributes. Add missing semconv attributes.**

Rationale:
1. **Datadog integration**: semconv attributes power LLM Observability features
2. **Standards compliance**: Any OTel-compatible tool will understand our spans
3. **Simplicity**: One set of attributes, one source of truth
4. **Future-proof**: GenAI semconv is evolving; staying aligned reduces tech debt

### What We Lose

- `k8s.namespace` has no semconv equivalent (keep this one?)
- `k8s.output_size_bytes` is useful for debugging large responses

**Pragmatic approach**: Keep `k8s.namespace` and `k8s.output_size_bytes` as our only custom attributes since they add value without semconv alternatives.

### What We Gain

- `gen_ai.operation.name: "execute_tool"` - Required attribute we're missing
- `gen_ai.tool.type: "function"` - Describes our tools correctly
- `gen_ai.tool.call.id` - Unique identifier for correlation
- Full Datadog LLM Observability integration
- Cleaner, more maintainable code
