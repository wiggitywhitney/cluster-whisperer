# PRD #33: OTel Baseline Trace Verification (M1)

Captured 2026-02-21 from Datadog APM using traces generated on 2026-02-19.
This document serves as the "before" snapshot for M5 post-refactor verification.

## Reference Traces

| Trace ID | Question | Mode | Tool Calls | Date |
|----------|----------|------|------------|------|
| `acb243e4a846b0b9bac12b7c0e074e39` | "How do I deploy a database in this cluster?" | MCP | 5 kubectl_get | 2026-02-19T14:56 |
| `72e7742d820e139cb5ee768a64dd04a6` | "What are the simplest, low-complexity resources?" | MCP | 1 vector_search | 2026-02-19T15:05 |

**Primary baseline trace**: `acb243e4a846b0b9bac12b7c0e074e39` (kubectl-heavy, exercises full hierarchy).

## Span Hierarchy

```text
cluster-whisperer.mcp.investigate (INTERNAL, root)
├── CompiledStateGraph.workflow (CLIENT, LangGraph auto)
│   └── [LangGraph internals: RunnableSequence, ChannelWrite, Branch]
├── anthropic.chat (CLIENT, OpenLLMetry auto)       ← first LLM call
│   └── [gen_ai.tool.definitions attached by ToolDefinitionsProcessor]
├── DynamicStructuredTool.task (CLIENT, LangChain auto)
├── kubectl_get.tool (INTERNAL, our withTool)       ← namespaces
│   └── kubectl get namespaces (CLIENT, our subprocess span)
├── ChannelWrite.workflow (CLIENT, LangGraph auto)
├── anthropic.chat (CLIENT, OpenLLMetry auto)       ← second LLM call
├── DynamicStructuredTool.task (CLIENT, LangChain auto)
├── kubectl_get.tool (INTERNAL, our withTool)       ← storageclasses
│   └── kubectl get storageclasses (CLIENT, our subprocess span)
├── ChannelWrite.workflow (CLIENT, LangGraph auto)
├── chat.anthropic (CLIENT, OpenLLMetry auto)       ← third LLM call
├── kubectl_get.tool (INTERNAL, our withTool)       ← pods
│   └── kubectl get pods (CLIENT, our subprocess span)
├── RunnableSequence.workflow (CLIENT, LangGraph auto)
│   └── [contains anthropic.chat + tool iterations]
├── kubectl_get.tool (INTERNAL, our withTool)       ← deployments
│   └── kubectl get deployments (CLIENT, our subprocess span)
├── kubectl_get.tool (INTERNAL, our withTool)       ← services
│   └── kubectl get services (CLIENT, our subprocess span)
├── ChannelWrite.workflow (CLIENT, LangGraph auto)
├── chat.anthropic (CLIENT, OpenLLMetry auto)       ← final LLM call
└── Branch<agent,continue,__end__>.workflow (CLIENT) ← terminal
```

### Span Types Summary

| Span Name Pattern | Kind | Source | Count (typical) |
|-------------------|------|--------|-----------------|
| `cluster-whisperer.mcp.investigate` | INTERNAL | Our code (context-bridge.ts) | 1 per trace |
| `CompiledStateGraph.workflow` | CLIENT | @traceloop/instrumentation-langchain | 1 per trace |
| `RunnableSequence.workflow` | CLIENT | @traceloop/instrumentation-langchain | 1+ per agent loop |
| `ChannelWrite.workflow` | CLIENT | @traceloop/instrumentation-langchain | 1 per state write |
| `Branch<...>.workflow` | CLIENT | @traceloop/instrumentation-langchain | 1 at terminal |
| `anthropic.chat` / `chat.anthropic` | CLIENT | @traceloop/instrumentation-langchain | 1 per LLM call |
| `DynamicStructuredTool.task` | CLIENT | @traceloop/instrumentation-langchain | 1 per tool dispatch |
| `kubectl_get.tool` | INTERNAL | Our code (withTool wrapper) | 1 per tool invocation |
| `kubectl get {resource}` | CLIENT | Our code (kubectl.ts) | 1 per subprocess |

## Span Attributes by Type

### Root Span: `cluster-whisperer.mcp.investigate`

| Attribute | Example Value | Source |
|-----------|---------------|--------|
| `cluster_whisperer.invocation.mode` | `mcp` | context-bridge.ts |
| `cluster_whisperer.mcp.tool.name` | `investigate` | context-bridge.ts |
| `cluster_whisperer.service.operation` | `investigate` | context-bridge.ts |
| `gen_ai.system` | `anthropic` | context-bridge.ts |
| `gen_ai.operation.name` | `chat` | context-bridge.ts |
| `gen_ai.request.model` | `claude-sonnet-4-20250514` | context-bridge.ts |
| `gen_ai.input.messages` | JSON array (content-gated) | context-bridge.ts |
| `gen_ai.output.messages` | JSON array (content-gated) | context-bridge.ts |
| `gen_ai.tool.call.id` | UUID | context-bridge.ts |
| `gen_ai.tool.name` | `investigate` | context-bridge.ts |
| `gen_ai.tool.type` | `function` | context-bridge.ts |
| `traceloop.entity.input` | JSON (question) | OpenLLMetry |
| `traceloop.entity.name` | `investigate` | OpenLLMetry |
| `traceloop.entity.output` | Answer text | OpenLLMetry |
| `traceloop.span.kind` | `workflow` | OpenLLMetry |

### LLM Spans: `anthropic.chat` / `chat.anthropic`

| Attribute | Example Value | Source |
|-----------|---------------|--------|
| `gen_ai.system` | `Anthropic` | OpenLLMetry auto |
| `gen_ai.request.model` | `claude-sonnet-4-20250514` | OpenLLMetry auto |
| `gen_ai.response.model` | `claude-sonnet-4-20250514` | OpenLLMetry auto |
| `gen_ai.usage.prompt_tokens` | `1673` | OpenLLMetry auto |
| `gen_ai.usage.completion_tokens` | `216` | OpenLLMetry auto |
| `gen_ai.request.max_tokens` | `10000` | OpenLLMetry auto |
| `gen_ai.prompt.N.content` | Prompt text (content-gated) | OpenLLMetry auto |
| `gen_ai.prompt.N.role` | `system` / `user` / `assistant` / `tool` | OpenLLMetry auto |
| `gen_ai.completion.0.content` | Response text (content-gated) | OpenLLMetry auto |
| `gen_ai.completion.0.role` | `assistant` | OpenLLMetry auto |
| `gen_ai.completion.0.finish_reason` | `tool_use` / `end_turn` | OpenLLMetry auto |
| `gen_ai.tool.definitions` | JSON tool schema array | ToolDefinitionsProcessor |

### Tool Spans: `kubectl_get.tool`

| Attribute | Example Value | Source |
|-----------|---------------|--------|
| `gen_ai.operation.name` | `execute_tool` | tool-tracing.ts |
| `gen_ai.tool.name` | `kubectl_get` | tool-tracing.ts |
| `gen_ai.tool.type` | `function` | tool-tracing.ts |
| `gen_ai.tool.call.id` | `a2ef90ca-d447-4ba1-883e-d41c15522342` | tool-tracing.ts |
| `gen_ai.tool.call.arguments` | `{"resource":"pods","namespace":"default"}` | tool-tracing.ts |
| `gen_ai.tool.call.result` | kubectl output text (content-gated) | tool-tracing.ts |
| `gen_ai.tool.description` | Tool description text | tool-tracing.ts |
| `traceloop.entity.input` | `{"args":[],"kwargs":{}}` | OpenLLMetry |
| `traceloop.entity.name` | `kubectl_get` | OpenLLMetry |
| `traceloop.entity.output` | kubectl output JSON string | OpenLLMetry |
| `traceloop.entity.path` | empty string | OpenLLMetry |
| `traceloop.span.kind` | `tool` | OpenLLMetry |

### kubectl Subprocess Spans: `kubectl get {resource}`

| Attribute | Example Value | Source |
|-----------|---------------|--------|
| `process.executable.name` | `kubectl` | kubectl.ts (semconv) |
| `process.command_args` | `["kubectl","get","pods","-n","default"]` | kubectl.ts (semconv) |
| `process.exit.code` | `0` | kubectl.ts (semconv) |
| `cluster_whisperer.k8s.namespace` | `default` | kubectl.ts (custom) |
| `cluster_whisperer.k8s.output_size_bytes` | `539` | kubectl.ts (custom) |
| `traceloop.entity.path` | `kubectl_get` | OpenLLMetry |

### Process/Runtime Attributes (all spans)

| Attribute | Value |
|-----------|-------|
| `process.command` | `/Users/.../dist/mcp-server.js` |
| `process.command_args` | `["/opt/homebrew/.../node", ".../dist/mcp-server.js"]` |
| `process.executable.name` | `/opt/homebrew/bin/node` |
| `process.executable.path` | `/opt/homebrew/Cellar/node/24.5.0/bin/node` |
| `process.owner` | `whitney.lee` |
| `process.pid` | PID number |
| `process.runtime.description` | `Node.js` |
| `process.runtime.name` | `nodejs` |
| `process.runtime.version` | `24.5.0` |

### OTel Library Metadata

| Span Type | `otel.library.name` | `otel.library.version` |
|-----------|---------------------|------------------------|
| Root span | `cluster-whisperer` | — |
| LangGraph spans | `@traceloop/instrumentation-langchain` | `0.22.6` |
| Tool spans | `@traceloop/node-server-sdk` | `0.22.6` / `0.22.7` |
| kubectl spans | `cluster-whisperer` | — |

## Datadog Query Templates for M5 Verification

Use these queries to verify the refactored traces match the baseline:

```text
# Find recent traces
service:cluster-whisperer

# Find kubectl spans specifically
service:cluster-whisperer resource_name:kubectl*

# Find tool spans
service:cluster-whisperer resource_name:kubectl_get.tool

# Find LLM spans
service:cluster-whisperer resource_name:anthropic.chat OR resource_name:chat.anthropic

# Find root spans
service:cluster-whisperer resource_name:cluster-whisperer.mcp.investigate
```

## M5 Verification Checklist

Verified 2026-02-21 after peer dependency refactor (M2-M4). Post-refactor trace `dfa3fe4773b7e83664852591344a4646` compared against baseline.

- [x] Root span `cluster-whisperer.cli.investigate` exists with all attributes (CLI mode; MCP variant also valid)
- [x] `anthropic.chat` spans have `gen_ai.system`, `gen_ai.request.model`, token usage metrics
- [x] `gen_ai.tool.definitions` attribute present on LLM chat spans (found on 8 spans)
- [x] Tool spans (`kubectl_get.tool`) have `gen_ai.operation.name: execute_tool` and all GenAI tool attributes
- [x] kubectl subprocess spans have `process.executable.name: kubectl`, `process.command_args`, `process.exit.code`
- [x] kubectl spans have `cluster_whisperer.k8s.output_size_bytes` (`k8s.namespace` absent — expected: no namespace-specific calls in this trace)
- [x] Parent-child relationships correct: root → tool → kubectl chain verified across 6 kubectl_get calls
- [x] All spans share trace ID `dfa3fe4773b7e83664852591344a4646` (94 spans total)
- [x] LangGraph auto-instrumented spans present: CompiledStateGraph, RunnableSequence, ChannelWrite, RunnableLambda, DynamicStructuredTool
- [x] `otel.status_code` is `Ok` on root, kubectl subprocess, and LLM spans

### Post-Refactor Trace Details

**CLI Trace**:

| Field | Value |
|-------|-------|
| Trace ID | `dfa3fe4773b7e83664852591344a4646` |
| Question | "How do I deploy a database in this cluster?" |
| Mode | CLI (`node dist/index.js`) |
| Root span | `cluster-whisperer.cli.investigate` |
| Tool calls | 1 vector_search (failed, ChromaDB down) + 6 kubectl_get |
| Total spans | 94 |
| Date | 2026-02-22T01:58:35Z |
| Exporter | OTLP → localhost:4318 (local Datadog Agent) |

**MCP Trace**:

| Field | Value |
|-------|-------|
| Trace ID | `4da342d9c6210f2f68f7c9c6c1f142de` |
| Question | "What pods are running in the default namespace?" |
| Mode | MCP (`node dist/mcp-server.js`) |
| Root span | `cluster-whisperer.mcp.investigate` |
| Tool calls | 1 kubectl_get |
| Date | 2026-02-22T02:26:06Z |
| Exporter | OTLP → localhost:4318 (local Datadog Agent) |
| MCP-specific attributes | `cluster_whisperer.invocation.mode: mcp`, `cluster_whisperer.mcp.tool.name: investigate`, `gen_ai.tool.call.id`, `gen_ai.tool.name: investigate`, `gen_ai.tool.type: function` |

### Expected Differences from M1 Baseline

| Difference | Why |
|------------|-----|
| CLI root span `cli.investigate` vs `mcp.investigate` | CLI invocation uses different root span name |
| No `cluster_whisperer.k8s.namespace` on CLI kubectl spans | CLI question triggered only cluster-scoped calls (CRDs, compositions) |
| New `cluster_whisperer.user.question` on root span | Enhancement added since M1 |
| `otel.status_code: Unset` on tool wrapper spans | OTel default; child kubectl spans have `Ok` |
