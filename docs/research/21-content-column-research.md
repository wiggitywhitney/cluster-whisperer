# Research: Datadog LLM Observability CONTENT Column

**PRD**: #21 - Fix LLM Observability CONTENT Column
**Date**: 2026-02-07

---

## Summary

The CONTENT column in Datadog's LLM Observability is empty/broken for cluster-whisperer traces because of two independent issues:

1. **OpenLLMetry-JS uses a deprecated attribute format** that Datadog's LLM Observability doesn't fully parse
2. **OpenLLMetry-JS fails to capture Anthropic completion content** when extended thinking is enabled

The fix requires setting `gen_ai.input.messages` and `gen_ai.output.messages` as span attributes in the format Datadog expects, on the correct spans.

---

## Q1: Why does Datadog show raw JSON or "No content"?

### Evidence: Actual trace attributes on `chat.anthropic` spans

From trace `a018b9759be514a81505225d6d78bdc7`, the `chat.anthropic` span set by OpenLLMetry-JS:

```
gen_ai.prompt.0.role: "system"
gen_ai.prompt.0.content: "# Kubernetes Investigation Assistant..."
gen_ai.prompt.1.role: "user"
gen_ai.prompt.1.content: "Find the broken pod and tell me why it's failing"
gen_ai.prompt.2.role: "assistant"
gen_ai.prompt.2.content: '[{"type":"thinking",...},{"type":"text",...},{"type":"tool_use",...}]'
gen_ai.prompt.3.role: "tool"
gen_ai.prompt.3.content: "NAMESPACE  NAME..."
gen_ai.completion.0.role: "assistant"
gen_ai.completion.0.content: ""   ← EMPTY
```

### Root causes

**Problem A: Deprecated attribute format.** OpenLLMetry-JS uses `gen_ai.prompt.N.role` / `gen_ai.prompt.N.content` flat indexed attributes. These were **removed from the OTel semantic conventions in v1.38.0**. Datadog's LLM Observability is built around the newer `gen_ai.input.messages` / `gen_ai.output.messages` format (v1.37+). The deprecated flat attributes may be partially recognized but not rendered cleanly in the CONTENT column.

**Problem B: Empty completion content.** `gen_ai.completion.0.content` is an empty string. OpenLLMetry's Anthropic instrumentation calls `JSON.stringify(result.content)` on the response, but with extended thinking enabled, the response content includes `thinking` blocks alongside `text` blocks. OpenLLMetry appears to fail to capture this correctly — the completion is written as an empty string.

**Problem C: JSON-stringified content blocks.** For assistant messages in the prompt history (messages 2, 4, 6, 8), OpenLLMetry JSON-stringifies the entire Anthropic content block array: `'[{"type":"thinking","thinking":"..."},{"type":"text","text":"..."},{"type":"tool_use",...}]'`. Even if Datadog could parse the deprecated format, it would see raw JSON rather than clean text.

### Why cluster-whisperer doesn't set `gen_ai.input.messages` / `gen_ai.output.messages`

The PRD mentions pre-work adding these attributes on the prd-7 branch, but they are **not present** in the current codebase on this branch. These attributes need to be implemented from scratch.

---

## Q2: What format do working instrumentations emit?

### OTel reference implementation (Python + JS): OTel Events

The official OTel OpenAI instrumentations use **OTel Events** (LogRecords attached to spans), not span attributes:

```python
# Python reference: emits per-message events
logger.emit(LogRecord(
    event_name="gen_ai.user.message",
    body={"content": "What pods are running?"}
))

# Output as gen_ai.choice event
logger.emit(LogRecord(
    event_name="gen_ai.choice",
    body={"index": 0, "finish_reason": "stop", "message": {"role": "assistant", "content": "..."}}
))
```

Event names: `gen_ai.system.message`, `gen_ai.user.message`, `gen_ai.assistant.message`, `gen_ai.tool.message`, `gen_ai.choice`.

### OTel v1.37+ consolidated format: Span attributes with `parts` schema

The newer semconv (opt-in via `OTEL_SEMCONV_STABILITY_OPT_IN=gen_ai_latest_experimental`) uses span attributes:

**`gen_ai.input.messages`** — JSON array:
```json
[
  {
    "role": "user",
    "parts": [{"type": "text", "content": "Find the broken pod"}]
  }
]
```

**`gen_ai.output.messages`** — JSON array:
```json
[
  {
    "role": "assistant",
    "parts": [{"type": "text", "content": "The broken pod is..."}],
    "finish_reason": "stop"
  }
]
```

### OpenLLMetry-JS (what cluster-whisperer uses): Deprecated flat attributes

Uses span attributes (not events) with indexed naming:
```
gen_ai.prompt.N.role = "user"
gen_ai.prompt.N.content = "Find the broken pod"
gen_ai.completion.N.role = "assistant"
gen_ai.completion.N.content = JSON.stringify(result.content)
```

This format is deprecated and tracked in [traceloop/openllmetry#3515](https://github.com/traceloop/openllmetry/issues/3515).

### Comparison table

| Aspect | OTel Reference | OTel v1.37+ | OpenLLMetry-JS |
|--------|---------------|-------------|----------------|
| Mechanism | OTel Events (LogRecords) | Span attributes | Span attributes |
| Input attr | Event body on `gen_ai.*.message` events | `gen_ai.input.messages` | `gen_ai.prompt.N.content` |
| Output attr | Event body on `gen_ai.choice` events | `gen_ai.output.messages` | `gen_ai.completion.N.content` |
| Content format | Plain string or structured dict | `parts` array with typed objects | JSON.stringify for complex content |
| Status | Current default | Experimental opt-in | **Deprecated** |

---

## Q3: Why doesn't CLI `on_chat_model_end` capture `finalAnswer`?

### Code analysis

The stream event handler in `src/index.ts:160-186` checks for `on_chat_model_end` events and processes content blocks:

```typescript
if (event.event === "on_chat_model_end") {
  const output = event.data.output;
  if (output?.content) {
    const content = output.content;
    if (typeof content === "string") {
      finalAnswer = content;
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === "thinking") {
          console.log(`Thinking: ${block.thinking}`);
        } else if (block.type === "text") {
          finalAnswer += block.text;
        }
      }
    }
  }
}
```

The code logic looks correct for standard Anthropic extended thinking content blocks. However, the PRD states that `setTraceOutput()` is never called, which means `finalAnswer` remains empty after the stream completes.

### Hypothesis: needs empirical verification

Possible causes (to be tested with debug logging in M2):

1. **LangGraph v2 stream events may use a different content structure.** The `on_chat_model_end` event's `data.output` is a LangChain `AIMessage` or `AIMessageChunk`. With interleaved thinking (`anthropic-beta: interleaved-thinking-2025-05-14`), the content block structure may differ from the standard format.

2. **The event might not fire for the final LLM call.** In LangGraph's ReAct loop, the final response (when the agent decides not to call any more tools) might emit a different event type.

3. **Content blocks may have different property names.** LangChain's `@langchain/anthropic` may transform Anthropic's `{type: "thinking", thinking: "..."}` into a different structure.

### Recommended debug approach for M2

Add temporary logging before the content block checks:
```typescript
if (event.event === "on_chat_model_end") {
  console.log("DEBUG on_chat_model_end:", JSON.stringify(event.data.output?.content, null, 2));
  // ... existing logic
}
```

This will reveal the exact content structure and whether the event fires at all for the final response.

### MCP mode comparison

MCP mode works correctly because it uses `agent.invoke()` instead of `agent.streamEvents()`, then directly accesses the last message's content blocks in `invokeInvestigator()` (`src/agent/investigator.ts:216-243`). This bypasses stream events entirely.

---

## Q4: Does Datadog require both INPUT and OUTPUT for the CONTENT column?

### Evidence from MCP traces

The MCP trace (`a018b9759be514a81505225d6d78bdc7`) has `traceloop.entity.output` set on the root span with the full investigation answer, and `traceloop.entity.input` set with the question JSON. However, neither `gen_ai.input.messages` nor `gen_ai.output.messages` are set on any span.

The `chat.anthropic` span has `gen_ai.completion.0.content: ""` (empty), so Datadog has no output content to display for the LLM call span.

### Assessment

Based on Datadog's LLM Observability documentation:
- The CONTENT column reads from `gen_ai.input.messages` and `gen_ai.output.messages` (or the older event-based equivalents) on **LLM call spans** (spans with `gen_ai.operation.name: "chat"`)
- `traceloop.entity.output` on workflow spans is a different attribute path — it shows in span tags but not in the LLM Observability CONTENT column
- INPUT and OUTPUT are displayed independently; fixing one doesn't require the other

---

## Q5: Is there an upstream issue for the empty completion with extended thinking?

### OpenLLMetry-JS thinking support status

**No existing issue for our specific problem.** The JS repo has partial thinking support:

- **PR [#671](https://github.com/traceloop/openllmetry-js/pull/671)** (merged Aug 2025): Added instrumentation for `anthropic.beta.messages.create()` — the **beta** endpoint only. Captures `llm.request.thinking.type` and `llm.request.thinking.budget_tokens`. Handles thinking + text blocks in responses.
- **Issue [#477](https://github.com/traceloop/openllmetry-js/issues/477)** (open): General request to instrument beta endpoints. PR #671 partially addressed this.

**The gap**: LangChain calls the **standard** `anthropic.messages.create()` endpoint, not the beta endpoint. The standard endpoint instrumentation does not handle thinking content blocks — it calls `JSON.stringify(result.content)` on the response, and with extended thinking the content array includes thinking blocks that apparently cause an empty string result.

The Python side has more complete support:
- **PR [#2780](https://github.com/traceloop/openllmetry/pull/2780)** (merged Mar 2025): Added thinking as a separate completion message in Python
- **PR [#3278](https://github.com/traceloop/openllmetry/pull/3278)** (open): Ongoing refactor for beta API wrappers and thinking blocks in Python

**This is a bug we could file** against `traceloop/openllmetry-js` — the standard messages API should handle extended thinking responses the same way the beta API does.

### Impact on cluster-whisperer

Extended thinking causes two problems:
1. **Empty `gen_ai.completion.0.content`** on `chat.anthropic` spans (OpenLLMetry bug)
2. **Likely the root cause of CLI `finalAnswer` extraction failure** (Q3) — interleaved thinking changes the content block structure in LangGraph stream events

Both CLI and MCP modes use the same agent instance with `thinking: { type: "enabled", budget_tokens: 4000 }` and `anthropic-beta: interleaved-thinking-2025-05-14`. The agent is configured in `src/agent/investigator.ts:136-158`.

---

## Recommended Fix Strategy

### Key decision: Disable extended thinking?

Disabling extended thinking would:
- **Fix OpenLLMetry completion capture** — without thinking blocks, `result.content` is a simple text string that serializes correctly
- **Likely fix CLI `on_chat_model_end`** — simpler content structure, no interleaved thinking blocks to parse
- **Simplify the gen_ai attribute format** — no thinking blocks to filter out of input/output messages
- **Lose**: thinking visibility in CLI output (italic "Thinking: ..." lines) and trace attributes
- **Lose**: possible investigation quality (though Sonnet 4 is highly capable without explicit thinking)

MCP mode already doesn't return thinking to the client — it only captures it in trace attributes. So the MCP user experience wouldn't change.

**Recommendation**: Disable extended thinking as the first step. This removes the root cause of Problems B and Q3, dramatically simplifying M2 and M3. If thinking visibility is needed later, it can be re-enabled once OpenLLMetry-JS fixes the standard API instrumentation.

### For M2 (CLI answer extraction)
1. Disable extended thinking in `src/agent/investigator.ts`
2. If `finalAnswer` extraction still fails, add debug logging to `on_chat_model_end`
3. Verify `setTraceOutput()` is called with non-empty content

### For M3 (gen_ai attribute format)
Set `gen_ai.input.messages` and `gen_ai.output.messages` as JSON-stringified span attributes using the **v1.37+ `parts` format**. These should be set on the `chat.anthropic` spans if possible, or on a span Datadog recognizes as an LLM call.

**Input format:**
```json
[{"role": "user", "parts": [{"type": "text", "content": "Find the broken pod..."}]}]
```

**Output format:**
```json
[{"role": "assistant", "parts": [{"type": "text", "content": "The broken pod is..."}], "finish_reason": "end_turn"}]
```

**Challenge**: The `chat.anthropic` spans are created by OpenLLMetry, not by our code. Options:
1. Add `gen_ai.input.messages` / `gen_ai.output.messages` to the **root investigation span** and see if Datadog picks them up
2. Use OpenTelemetry SpanProcessor to intercept `chat.anthropic` spans and add the attributes
3. Wait for OpenLLMetry to fix [#3515](https://github.com/traceloop/openllmetry/issues/3515) (not recommended — timeline unknown)

Option 1 is simplest and should be tried first. If Datadog doesn't parse them from workflow-type spans, escalate to option 2.

---

## Sources

- **Trace evidence**: Datadog trace `a018b9759be514a81505225d6d78bdc7` (cluster-whisperer MCP mode, 2026-02-07)
- **OTel GenAI Semantic Conventions**: [gen-ai-spans](https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-spans/) — defines `gen_ai.input.messages` and `gen_ai.output.messages` as opt-in span attributes
- **OTel GenAI Events**: [gen-ai-events](https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-events/) — event body schema with `parts` format
- **Datadog OTel instrumentation docs**: [otel_instrumentation](https://docs.datadoghq.com/llm_observability/instrumentation/otel_instrumentation/) — v1.37+ semconv support
- **Datadog blog**: [LLM Observability supports OTel GenAI semconv](https://www.datadoghq.com/blog/llm-otel-semantic-convention/)
- **OpenLLMetry-JS issue**: [traceloop/openllmetry#3515](https://github.com/traceloop/openllmetry/issues/3515) — deprecated attributes
- **OpenLLMetry-JS Anthropic source**: `openllmetry-js/packages/instrumentation-anthropic/src/instrumentation.ts` — flat `gen_ai.prompt.N.*` attribute format
- **OpenLLMetry-JS thinking PR**: [traceloop/openllmetry-js#671](https://github.com/traceloop/openllmetry-js/pull/671) — beta endpoint only, not standard API
- **OpenLLMetry-JS beta endpoints issue**: [traceloop/openllmetry-js#477](https://github.com/traceloop/openllmetry-js/issues/477) — general beta instrumentation request
- **OpenLLMetry Python thinking PR**: [traceloop/openllmetry#2780](https://github.com/traceloop/openllmetry/pull/2780) — Python has thinking support on standard API
