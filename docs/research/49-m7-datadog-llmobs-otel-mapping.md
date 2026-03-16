# Research: Datadog LLM Observability OTel GenAI Semantic Convention Mapping

**Date:** 2026-03-16
**Context:** PRD #49 M7 — Vercel agent OTel instrumentation. Discovered during verification that Vercel SDK span names differ from predictions and Datadog layer classification depends on specific attributes.

## Summary

Datadog LLM Observability natively ingests OTel GenAI Semantic Conventions (v1.37+) and maps `gen_ai.operation.name` to its internal span kinds. Without this attribute, spans default to "workflow" regardless of other gen_ai.* attributes present.

## Critical Mapping Table (from Datadog docs)

| `gen_ai.operation.name` | Datadog LLM Obs span.kind |
|---|---|
| `generate_content`, `chat`, `text_completion`, `completion` | **llm** |
| `embeddings`, `embedding` | **embedding** |
| `execute_tool` | **tool** |
| `invoke_agent`, `create_agent` | **agent** |
| `rerank`, `unknown`, (default/missing) | **workflow** |

OpenLLMetry fallback (when `gen_ai.operation.name` absent):

| `llm.request.type` | Datadog LLM Obs span.kind |
|---|---|
| `chat` | **llm** |
| `completion` | **llm** |
| `embedding` | **embedding** |
| `rerank`, `unknown`, (default) | **workflow** |

Model provider resolution: `gen_ai.provider.name` → falls back to `gen_ai.system` → then "custom".

## Required Attributes per Layer

- **Agent**: `gen_ai.operation.name: "invoke_agent"`, `gen_ai.provider.name`, `gen_ai.agent.name`
- **LLM**: `gen_ai.operation.name: "chat"`, `gen_ai.provider.name`, `gen_ai.request.model`, token usage
- **Tool**: `gen_ai.operation.name: "execute_tool"`, `gen_ai.tool.name`, `gen_ai.tool.call.id`
- **Workflow**: default (no `gen_ai.operation.name` or unrecognized value)

## Actual Span Analysis (from live Datadog API queries)

### LangGraph Agent Spans in Datadog

| Span | `gen_ai.operation.name` | `llm.request.type` | → Datadog Layer |
|---|---|---|---|
| `cluster-whisperer.cli.investigate` (root) | `chat` | — | **llm** (WRONG — should be workflow/agent) |
| `CompiledStateGraph.workflow` | — | — | **workflow** (default) |
| `anthropic.chat` (×N) | — | `chat` | **llm** (OpenLLMetry fallback) |
| `DynamicStructuredTool.task` (×N) | — | — | **workflow** (default) |
| `kubectl_get.tool` etc. | `execute_tool` | — | **tool** |

### Vercel Agent Spans in Datadog

| Span | `gen_ai.operation.name` | `ai.operationId` | → Datadog Layer |
|---|---|---|---|
| `cluster-whisperer.cli.investigate` (root) | `chat` | — | **llm** (WRONG — should be workflow/agent) |
| `vercel.agent` (outer, runtime name for `ai.streamText`) | — | `ai.streamText` | **workflow** (default) |
| `text.stream` (per-step, runtime name for `ai.streamText.doStream`) | — | `ai.streamText.doStream` | **workflow** (WRONG — should be llm) |
| tool span (runtime name varies by `functionId`) | `execute_tool` | `ai.toolCall` | **tool** |
| `kubectl_get.tool` | `execute_tool` | — | **tool** |

### Gap Analysis

Neither agent produces an **Agent** layer span — no `invoke_agent` operation anywhere.

The root span's `gen_ai.operation.name: "chat"` (set by `withAgentTracing()` in M3) incorrectly classifies it as LLM in both agents.

Vercel SDK's LLM spans (`ai.streamText.doStream`) have ALL gen_ai.* attributes for proper LLM classification EXCEPT `gen_ai.operation.name` — they default to workflow.

## Key Findings

### 1. No OpenLLMetry Instrumentation for Vercel AI SDK

Confirmed by checking [openllmetry-js monorepo](https://github.com/traceloop/openllmetry-js/tree/main/packages): 13 instrumentation packages exist (anthropic, openai, langchain, chromadb, qdrant, etc.) but none for the Vercel AI SDK (`ai` package).

### 2. Vercel SDK experimental_telemetry Span Names

The SDK's `experimental_telemetry` produces non-standard span names that differ from M1 research predictions:

| Predicted (PRD) | Actual Runtime | `ai.operationId` |
|---|---|---|
| `ai.streamText` | `vercel.agent` | `ai.streamText` |
| `ai.streamText.doStream` | `text.stream` | `ai.streamText.doStream` |
| `ai.toolCall` | `cluster-whisperer-investigate` | `ai.toolCall` |

The `ai.operationId` attribute preserves the original operation name and can be used for identification.

### 3. OpenLLMetry Version Gap

Datadog docs state: "OpenLLMetry version 0.47+ is supported." Project uses v0.22.6. The OpenLLMetry fallback mapping (`llm.request.type`) may still work but is not guaranteed for all features.

### 4. SpanProcessor Fix for All 4 Layers

A SpanProcessor that enriches spans on export can fix the Datadog layer classification:

| Span Condition | Add Attribute | Result |
|---|---|---|
| `ai.operationId = "ai.streamText.doStream"` | `gen_ai.operation.name: "chat"` | → **llm** |
| `ai.operationId = "ai.streamText"` | `gen_ai.operation.name: "invoke_agent"` + `gen_ai.agent.name` | → **agent** |
| Root span (`cluster-whisperer.cli.investigate`) | Change `gen_ai.operation.name` from `"chat"` to remove or default | → **workflow** |

This produces all 4 layers: agent (outer SDK span), workflow (root span), llm (per-step SDK spans), tool (existing).

## OTel GenAI Span Naming Convention

Per the spec, span names SHOULD be:
- LLM: `{gen_ai.operation.name} {gen_ai.request.model}` → `chat claude-sonnet-4-20250514`
- Tool: `execute_tool {gen_ai.tool.name}` → `execute_tool kubectl_get`
- Agent: `invoke_agent {gen_ai.agent.name}` → `invoke_agent cluster-whisperer`

## Sources

- [Datadog OTel Instrumentation Docs](https://docs.datadoghq.com/llm_observability/instrumentation/otel_instrumentation/) — full mapping table, attribute reference
- [Datadog Blog: OTel GenAI Semantic Convention Support](https://www.datadoghq.com/blog/llm-otel-semantic-convention/) — native v1.37+ support
- [OTel GenAI Spans Spec](https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-spans/) — operation names, required attrs
- [OTel GenAI Agent Spans Spec](https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-agent-spans/) — invoke_agent, create_agent
- [OTel GenAI Attribute Registry](https://opentelemetry.io/docs/specs/semconv/registry/attributes/gen-ai/) — complete gen_ai.* list
- [OpenLLMetry JS packages](https://github.com/traceloop/openllmetry-js/tree/main/packages) — no Vercel AI SDK instrumentation
