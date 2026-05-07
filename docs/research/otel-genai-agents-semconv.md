# Research: OTel GenAI Semantic Conventions for Agents

**Project:** cluster-whisperer
**Last Updated:** 2026-05-07

## Update Log

| Date | Summary |
|------|---------|
| 2026-05-07 | Initial research — current spec status, new operation names, events vs attributes, Datadog support |

## Summary

`gen_ai.input.messages` / `gen_ai.output.messages` with the `parts` schema are still the correct attribute names and format — confirmed by both the OTel spec and Datadog docs as the primary mechanism for LLM content. The GenAI semconv has moved to a dedicated GitHub repo (`open-telemetry/semantic-conventions-genai`). OTel Events (`gen_ai.client.inference.operation.details`) are now formally defined as a *complementary* fallback — not a replacement for span attributes. New operation name `invoke_workflow` was added in v1.40.0 and is relevant for our root investigation span.

### Surprises & Gotchas

**🟢 Spec moved to a dedicated repo** — `https://github.com/open-telemetry/semantic-conventions/blob/main/docs/gen-ai/gen-ai-spans.md` now redirects with a notice: "GenAI semantic conventions have moved to the [OpenTelemetry GenAI semantic conventions repository](https://github.com/open-telemetry/semantic-conventions-genai). This page has moved and is no longer maintained in this repository." Any links to the old location are stale. The new repo is at `open-telemetry/semantic-conventions-genai`, current schema version 1.42.0 (no releases published yet — active development).

**🟡 `invoke_workflow` is a new operation name, but Datadog hasn't documented it explicitly** — Added in OTel semconv v1.40.0. Datadog's mapping table does NOT list it — it falls through to the default "workflow" span kind (same as `rerank`, `unknown`, or missing). So it would work in practice, but is not a Datadog-documented value. Our root investigation span currently uses `gen_ai.operation.name: "chat"` which makes it show as "llm" in Datadog — incorrect. Changing to `invoke_workflow` would make it show as "workflow", but treat this as relying on undocumented fallback behavior until Datadog explicitly adds it to their mapping table. This is a pending fix identified in PRD #49 M7 research but not yet implemented.

**🟢 OTel Events are a fallback, not a replacement** — Datadog checks sources in priority order: (1) direct span attributes (`gen_ai.input.messages`), (2) span events (`gen_ai.client.inference.operation.details`). Our approach of setting span attributes directly is the highest-priority path and remains correct.

**🟡 `gen_ai.conversation.id` is Datadog-recognized** — Now mapped to `metadata.conversation_id` in Datadog LLM Obs. Not implemented in cluster-whisperer. Could enable grouping multi-turn interactions in the UI.

**🔴 Still Development status** — All GenAI semconv is still experimental/development as of May 2026. No stable release. Continue using `OTEL_SEMCONV_STABILITY_OPT_IN=gen_ai_latest_experimental` for opt-in.

### Findings

#### 1. `gen_ai.input.messages` / `gen_ai.output.messages` — Still Current

🟢 **High confidence** — confirmed in Datadog docs (direct attribute fetch, primary source).

**Source says:** "Input and output messages are extracted from the following sources, in priority order: Direct attributes: `gen_ai.input.messages`, `gen_ai.output.messages`" ([Datadog OTel Instrumentation Docs](https://docs.datadoghq.com/llm_observability/instrumentation/otel_instrumentation/))

**Parts format confirmed:**
```json
{ "role": "user", "parts": [{"type": "text", "content": "..."}] }
```

No changes to attribute names or format since v1.37. The `parts` schema is what Datadog parses.

#### 2. OTel Events: Complementary, Not Replacement

🟢 **High confidence** — confirmed in both OTel spec and Datadog docs.

The event `gen_ai.client.inference.operation.details` is now formally defined in the spec. Datadog supports it as a fallback after direct span attributes. Events are opt-in and marked Development status.

**Source says:** "Span events (`meta["events"]`) with name `gen_ai.client.inference.operation.details`" are recognized by Datadog as a fallback source. ([Datadog OTel Instrumentation Docs](https://docs.datadoghq.com/llm_observability/instrumentation/otel_instrumentation/))

**Interpretation:** Our approach (set `gen_ai.input.messages` directly as span attributes) is the highest-priority mechanism. No need to switch to events.

#### 3. Current `gen_ai.operation.name` Values

🟢 **High confidence** — confirmed in Datadog mapping table (prior PRD #49 research still accurate) plus new value from v1.40.0.

| Value | Datadog span kind | Notes |
|---|---|---|
| `chat`, `generate_content`, `text_completion`, `completion` | **llm** | |
| `embeddings`, `embedding` | **embedding** | |
| `execute_tool` | **tool** | |
| `invoke_agent`, `create_agent` | **agent** | |
| `invoke_workflow` | **workflow** (default fallback) | New in OTel v1.40.0 — not yet in Datadog docs |
| `rerank`, `unknown`, missing | **workflow** | Default |

**`invoke_workflow`** is the semantically correct value for our root investigation span — it coordinates multiple agent steps and tool calls. Currently we use `chat` (which misclassifies it as "llm"). Fixing this is the change identified but not yet landed from PRD #49 M7.

#### 4. Agent Span Attributes

🟢 **High confidence** — from OTel agent spans spec.

Required for `invoke_agent` operation:
- `gen_ai.operation.name: "invoke_agent"` (required)
- `gen_ai.provider.name` (required)
- `gen_ai.agent.name` (conditionally required when available — influences span naming)

New attributes added since early 2026:
- `gen_ai.conversation.id` — tracks conversation across multi-turn interactions; Datadog maps to `metadata.conversation_id`
- `gen_ai.workflow.name` — names a coordinated multi-agent workflow

#### 5. Spec Repository Migration

🟢 **High confidence** — observed directly when fetching the old GitHub URL.

The main `open-telemetry/semantic-conventions` repo now redirects GenAI spec pages to `open-telemetry/semantic-conventions-genai`. Current schema version in the new repo: **1.42.0**. Still no published releases — active development only. The OTel website docs pages (`opentelemetry.io/docs/specs/semconv/gen-ai/`) still work and reflect the current spec.

### Recommendation

1. **Keep `gen_ai.input.messages` / `gen_ai.output.messages` with parts format** — no change needed. This is correct and highest-priority in Datadog.

2. **Change root span `gen_ai.operation.name` from `"chat"` to `"invoke_workflow"`** — this makes the root investigation span show as "workflow" in Datadog instead of incorrectly as "llm". Low-risk one-line change in `src/tracing/context-bridge.ts`.

3. **Consider adding `gen_ai.conversation.id`** — would enable grouping in Datadog LLM Obs for users who run multiple investigations. Medium effort; requires generating a conversation ID at the CLI/MCP entry point.

4. **No need to switch to OTel Events** — events are a complementary fallback. Our span attribute approach is higher priority.

5. **Update spec links** in any documentation — point to `open-telemetry/semantic-conventions-genai` instead of the old main repo.

### Caveats

- GenAI semconv remains Development/experimental — no stable release as of May 2026. API can break on minor version bumps.
- Datadog support lags behind the spec. `invoke_workflow` is in the mapping table but the blog post has not been updated to reflect it explicitly — verify in Datadog UI after implementing.
- `gen_ai.conversation.id` behavior in Datadog LLM Obs (how it groups spans) is documented but not yet verified empirically in cluster-whisperer.

## Sources

- [OTel GenAI Spans Spec](https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-spans/) — current attribute names and operation values
- [OTel GenAI Events Spec](https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-events/) — event body schema, complementary to span attributes
- [OTel GenAI Agent Spans Spec](https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-agent-spans/) — invoke_agent, invoke_workflow, gen_ai.agent.name
- [OTel GenAI Semantic Conventions repo](https://github.com/open-telemetry/semantic-conventions-genai) — new dedicated repo, schema v1.42.0
- [OTel Semantic Conventions Releases](https://github.com/open-telemetry/semantic-conventions/releases) — changelog showing invoke_workflow added in v1.40.0
- [Datadog OTel Instrumentation Docs](https://docs.datadoghq.com/llm_observability/instrumentation/otel_instrumentation/) — Datadog's supported attributes and priority order for content column
- [Datadog Blog: OTel GenAI Semantic Convention Support](https://www.datadoghq.com/blog/llm-otel-semantic-convention/) — native v1.37+ support announcement
