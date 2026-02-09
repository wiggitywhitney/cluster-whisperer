# How We Fixed the LLM Observability CONTENT Column

**PRD**: #21 — Fix LLM Observability CONTENT Column
**Date**: 2026-02-09

---

## The Problem

Cluster-whisperer sends traces to Datadog via OpenTelemetry. In Datadog's **LLM Observability** view, there's a CONTENT column that's supposed to show what you asked the LLM and what it answered — the INPUT and OUTPUT. For cluster-whisperer, this was broken in two ways:

1. **OUTPUT said "No content"** — completely blank
2. **INPUT showed raw JSON** like `[{"content":"Find...` instead of the readable question

This matters because the whole point for the KubeCon demo is that the audience sees the full investigation flow in Datadog: question in, answer out.

## Three Independent Root Causes

Research (M1) revealed this was actually **three separate problems** layered on top of each other.

### Problem 1: OpenLLMetry uses a deprecated attribute format

Cluster-whisperer uses **OpenLLMetry-JS** to auto-instrument LLM calls. OpenLLMetry writes trace attributes in an old format:

```
gen_ai.prompt.0.role = "user"
gen_ai.prompt.0.content = "Find the broken pod..."
gen_ai.completion.0.role = "assistant"
gen_ai.completion.0.content = "..."
```

This flat indexed format (`gen_ai.prompt.N.*`) was **removed from the OTel semantic conventions in v1.38.0**. Datadog's LLM Observability is built around the newer format: `gen_ai.input.messages` and `gen_ai.output.messages`. So even when OpenLLMetry wrote data, Datadog couldn't render it properly in the CONTENT column.

### Problem 2: OpenLLMetry's completion content was empty anyway

Even if Datadog could read the old format, `gen_ai.completion.0.content` was an **empty string**. Why? OpenLLMetry-JS's Anthropic instrumentation calls `JSON.stringify(result.content)` on the API response. But cluster-whisperer uses **extended thinking** (Claude's chain-of-thought feature), which means the response content includes `thinking` blocks alongside `text` blocks. OpenLLMetry-JS only handles thinking for the beta Anthropic endpoint, not the standard one that LangChain uses. With thinking blocks present, the serialization produces an empty string. This is an upstream bug we can't fix.

### Problem 3: The CLI never captured the final answer at all

Separately from the Datadog rendering issue, the CLI code in `src/index.ts` was supposed to extract the agent's final answer from the LangGraph stream and call `setTraceOutput()` to write it to the trace. But `setTraceOutput()` was **never called** — `finalAnswer` was always empty.

The M1 research hypothesized this was also caused by extended thinking changing the content block structure. **M2 disproved this empirically.** The actual cause: the code listened for `on_chat_model_end`, `on_tool_start`, and `on_tool_end` stream events, but **LangGraph v2's `streamEvents()` never emits those event types**. It emits `on_chain_stream` and `on_chain_end` instead. The event handlers literally never matched. Extended thinking had nothing to do with it.

## The Fixes

### M2: Fix CLI answer extraction

Rewrote the stream event handlers in `src/index.ts` to listen for `on_chain_stream` events instead of the non-existent `on_chat_model_end`. These `on_chain_stream` chunks contain agent messages (with thinking + text + tool_calls) and tool results. After this fix, `finalAnswer` gets populated and `setTraceOutput()` is called, so `traceloop.entity.output` appears on the root span in Datadog.

### M3: Add the correct gen_ai attributes for Datadog

Since OpenLLMetry's deprecated format doesn't work and we can't fix the upstream bug, we **bypass OpenLLMetry entirely** for the CONTENT column. In `src/tracing/context-bridge.ts`, we manually set `gen_ai.input.messages` and `gen_ai.output.messages` as span attributes on our root investigation span, using the **OTel v1.37+ `parts` format** that Datadog expects:

```json
// INPUT
[{"role": "user", "parts": [{"type": "text", "content": "Find the broken pod..."}]}]

// OUTPUT
[{"role": "assistant", "parts": [{"type": "text", "content": "## Summary: Found..."}], "finish_reason": "end_turn"}]
```

For Datadog to recognize these attributes, the span also needs `gen_ai.system`, `gen_ai.operation.name`, and `gen_ai.request.model` — these tell Datadog "this is an LLM call span, look for input/output messages on it."

This works for both code paths:

- **CLI mode** (`withAgentTracing`) — sets input at span creation, output via `setTraceOutput()` after streaming completes
- **MCP mode** (`withMcpRequestTracing`) — same pattern, with the `investigate` tool getting the `chat` operation type while individual kubectl tools get `execute_tool`

## The Result

The Datadog LLM Observability CONTENT column now shows clean, readable text:

- **INPUT**: "Find the broken pod..." (not raw JSON)
- **OUTPUT**: "## Summary: Found..." (not "No content")

Both CLI and MCP modes verified in Datadog on 2026-02-09.

## Key Files

| File | What changed |
|------|-------------|
| `src/index.ts` | M2 — Rewrote stream event handlers from `on_chat_model_end` to `on_chain_stream` |
| `src/tracing/context-bridge.ts` | M3 — Added `gen_ai.input/output.messages` in v1.37+ `parts` format, plus `gen_ai.system`/`operation.name`/`request.model` |
| `src/tools/mcp/index.ts` | M3 — Pass clean `answer` to `setTraceOutput()` separately from full trace output |

## Related

- Research document: `docs/research/21-content-column-research.md`
- Upstream OpenLLMetry issue (deprecated attributes): [traceloop/openllmetry#3515](https://github.com/traceloop/openllmetry/issues/3515)
- Upstream OpenLLMetry-JS bug (empty completion with thinking): [traceloop/openllmetry-js#671](https://github.com/traceloop/openllmetry-js/pull/671)
