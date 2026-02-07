# PRD #21: Fix LLM Observability CONTENT Column

**Status**: In Progress
**Created**: 2026-02-07
**GitHub Issue**: [#21](https://github.com/wiggitywhitney/cluster-whisperer/issues/21)

---

## Problem Statement

The Datadog LLM Observability CONTENT column doesn't display cluster-whisperer's questions and answers properly:

- **OUTPUT**: Shows "No content" because the CLI's stream event parsing never captures the agent's final answer, so `setTraceOutput()` is never called and no output attributes are written to the span.
- **INPUT**: Shows raw JSON `[{"content":"Find...` instead of clean extracted text. Datadog reads our `gen_ai.input.messages` attribute but doesn't render the text cleanly.

This matters for the KubeCon demo — the audience needs to see the full investigation flow (question → reasoning → answer) in Datadog's trace view.

## Solution

1. **Research** what format Datadog actually parses for the CONTENT column (official OTel instrumentation source code, Datadog's own SDK, working examples)
2. **Fix CLI answer extraction** — the `on_chat_model_end` stream events aren't producing output in `src/index.ts`
3. **Complete the `gen_ai.input/output.messages` workaround** using the correct format from research
4. **Verify end-to-end** in both CLI and MCP modes

---

## Current State (Work Done Before PRD)

The following changes have already been made on the `feature/prd-7-vector-database-chroma` branch (will be moved to a dedicated branch when implementation starts):

### Already completed:
- Renamed env var `OTEL_TRACE_CONTENT_ENABLED` → `OTEL_CAPTURE_AI_PAYLOADS` across entire codebase
- Renamed code variable `isTraceContentEnabled` → `isCaptureAiPayloads`
- Updated all docs, CLAUDE.md, .mcp.json, README.md, Weaver schema
- Regenerated `telemetry/registry/resolved.json`
- Confirmed OUTPUT is missing due to `setTraceOutput()` never being called

**Note**: The `gen_ai.input.messages` / `gen_ai.output.messages` attributes mentioned in the original PRD were on the prd-7 branch and are **not present** on this branch. They need to be implemented from scratch.

### What remains:
- Fix: CLI `finalAnswer` extraction from `on_chat_model_end` stream events
- Fix: Implement `gen_ai.input/output.messages` in correct v1.37+ format
- Verify: End-to-end CONTENT column rendering in both CLI and MCP modes
- Verify: MCP mode with new code (requires Claude Code restart to pick up `.mcp.json` changes)

---

## Key Research Finding: Extended Thinking Is the Root Cause

Research (see `docs/research/21-content-column-research.md`) revealed that **extended thinking is the root cause** of two major problems:

1. **Empty `gen_ai.completion.0.content`**: OpenLLMetry-JS's thinking support (PR [#671](https://github.com/traceloop/openllmetry-js/pull/671)) only covers `anthropic.beta.messages.create()`, not the standard `anthropic.messages.create()` that LangChain uses. With extended thinking enabled, the completion content is an empty string.

2. **CLI `finalAnswer` extraction failure**: Interleaved thinking (`anthropic-beta: interleaved-thinking-2025-05-14`) likely changes the content block structure in LangGraph v2 stream events, preventing the `on_chat_model_end` handler from capturing text.

**Decision**: Disable extended thinking as the first implementation step. This removes the root cause, simplifying M2 and M3. MCP mode already doesn't return thinking to the client — it only captures it in trace attributes. Extended thinking can be re-enabled later once OpenLLMetry-JS fixes standard API instrumentation.

---

## Research Approach

**Primary sources, then reference implementations.**

### Questions to Answer

1. **Why does Datadog render `gen_ai.input.messages` as raw JSON instead of extracting text?**
   - Is it the `parts` array format? Does Datadog expect a simpler structure?
   - Does Datadog only parse structured OTel events, not JSON string span attributes?
   - Is there a 256-char truncation issue?

2. **What format do working instrumentations actually emit?**
   - What does `@opentelemetry/instrumentation-openai` produce for `gen_ai.input.messages`?
   - What does Datadog's own `dd-trace-py` Anthropic/OpenAI integration produce?
   - Are they using the `parts` format or a simpler OpenAI-style `content` string?

3. **Why does CLI `on_chat_model_end` not capture the final answer?**
   - Is the event name different in LangGraph v2 stream events?
   - Is the content structure different with extended thinking enabled?
   - Does MCP's `agent.invoke()` approach work because it avoids stream events entirely?

4. **Does Datadog require both INPUT and OUTPUT to render the CONTENT column?**
   - Will fixing OUTPUT alone resolve the INPUT display issue too?

### Sources to Investigate

- **OTel GenAI semconv**: [gen-ai-events.md](https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-events/) and [gen-ai-input-messages.json schema](https://github.com/open-telemetry/semantic-conventions/blob/main/docs/gen-ai/gen-ai-input-messages.json)
- **OTel Python OpenAI instrumentation**: [opentelemetry-python-contrib/instrumentation-genai](https://github.com/open-telemetry/opentelemetry-python-contrib/tree/main/instrumentation-genai) — reference implementation Datadog tests against
- **Datadog OTel instrumentation docs**: [docs.datadoghq.com/llm_observability/instrumentation/otel_instrumentation/](https://docs.datadoghq.com/llm_observability/instrumentation/otel_instrumentation/)
- **Datadog blog**: [Datadog LLM Observability supports OTel GenAI semconv](https://www.datadoghq.com/blog/llm-otel-semantic-convention/)
- **LangGraph stream events**: LangGraph documentation for v2 event format and event types
- **Upstream issue**: [traceloop/openllmetry#3515](https://github.com/traceloop/openllmetry/issues/3515) — our bug report about deprecated attributes

### Research Output

Research findings will be documented in `docs/research/21-content-column-research.md` and referenced at the start of each implementation milestone.

---

## Milestones

### M1: Research — Determine Correct Format and Root Causes
- [x] Investigate what format Datadog actually parses for the CONTENT column by examining working OTel instrumentation source code
- [x] Determine root causes of empty completion and CLI finalAnswer failure (extended thinking identified as root cause; empirical debug logging deferred to M2)
- [x] Document findings in `docs/research/21-content-column-research.md`

**Success criteria**: Research document answers all 4 questions above with evidence (code references, trace examples, or Datadog docs).

### M2: Disable Extended Thinking and Fix CLI Answer Extraction
- [ ] Disable extended thinking in `src/agent/investigator.ts` (remove `thinking` config and `interleaved-thinking` beta header)
- [ ] Update `src/index.ts` stream event handling to remove thinking block logic (simplify `on_chat_model_end` handler)
- [ ] Update `src/agent/investigator.ts` `invokeInvestigator()` to remove thinking block parsing
- [ ] Update `src/tools/mcp/index.ts` `buildTraceOutput()` to remove thinking section
- [ ] Verify `finalAnswer` is captured and `setTraceOutput()` is called in CLI mode
- [ ] Verify `gen_ai.completion.0.content` is no longer empty on `chat.anthropic` spans
- [ ] Verify CLI prints "Answer:" with the response text

**Success criteria**: Run `vals exec -i -f .vals.yaml -- node dist/index.js "Find the broken pod and tell me why it's failing"` and see both terminal output AND `traceloop.entity.output` on the Datadog trace. `gen_ai.completion.0.content` is populated on `chat.anthropic` spans.

### M3: Correct gen_ai.input/output.messages Format
- [ ] Read research document
- [ ] Adjust `gen_ai.input.messages` and `gen_ai.output.messages` format in `context-bridge.ts` based on research findings
- [ ] Test both CLI and MCP modes (MCP requires Claude Code restart)
- [ ] Verify CONTENT column in Datadog LLM Observability shows clean text for both INPUT and OUTPUT

**Success criteria**: Datadog LLM Observability trace list shows readable text (not raw JSON) in the CONTENT column for both INPUT and OUTPUT.

### M4: Update Documentation and Schema
- [ ] Read research document
- [ ] Add `gen_ai.input.messages` and `gen_ai.output.messages` to Weaver schema (`telemetry/registry/attributes.yaml`)
- [ ] Update `docs/opentelemetry.md` Known Limitations section with final status
- [ ] Update `docs/tracing-conventions.md` Content Gating section with new env var name and gen_ai attributes
- [ ] Regenerate `resolved.json`

**Success criteria**: `npm run telemetry:check` and `npm run telemetry:resolve` pass. Documentation accurately reflects the current implementation.

### M5: End-to-End Verification
- [ ] Run CLI mode with tracing → verify CONTENT column in Datadog
- [ ] Run MCP mode via Claude Code → verify CONTENT column in Datadog
- [ ] Confirm both INPUT and OUTPUT render as readable text
- [ ] Verify no regressions in span hierarchy or other trace attributes

**Success criteria**: Both CLI and MCP traces show clean INPUT and OUTPUT text in the Datadog LLM Observability CONTENT column. Traces verified via `search_datadog_spans` MCP tool.

---

## Key Files

| File | Role |
|------|------|
| `src/index.ts` | CLI entry point — stream event parsing, `finalAnswer` extraction |
| `src/tracing/context-bridge.ts` | Root span creation, `gen_ai.input/output.messages` attributes |
| `src/tracing/index.ts` | `isCaptureAiPayloads` flag, OpenLLMetry config |
| `src/tools/mcp/index.ts` | MCP entry point — `setTraceOutput()` call (works correctly) |
| `src/agent/investigator.ts` | Agent config (extended thinking settings), `invokeInvestigator()` — MCP's non-streaming approach |
| `docs/opentelemetry.md` | Known limitations and workaround documentation |
| `docs/tracing-conventions.md` | Content gating docs, attribute reference |
| `telemetry/registry/attributes.yaml` | Weaver schema for span attributes |

## Dependencies

- Running Kubernetes cluster (Docker Desktop / kind) for testing
- Datadog Agent running locally on `localhost:4318` for OTLP export
- Datadog LLM Observability access for verifying CONTENT column
- Claude Code restart required to test MCP mode with code changes

## Risks

| Risk | Mitigation |
|------|------------|
| Datadog may not fully support `parts` format yet | Research M1 determined actual format; can fall back to simpler OpenAI-style format |
| OpenLLMetry may overwrite our manual `gen_ai.*` attributes | Test carefully; may need to set attributes after OpenLLMetry's instrumentation runs |
| Disabling extended thinking may reduce investigation quality | Sonnet 4 is highly capable without explicit thinking; re-enable once OpenLLMetry fixes standard API |
| OpenLLMetry empty completion may persist even without thinking | Verify `gen_ai.completion.0.content` is populated after disabling thinking; file upstream issue if not |

---

## Progress Log

| Date | Milestone | Notes |
|------|-----------|-------|
| 2026-02-07 | Pre-PRD | Added `gen_ai.input/output.messages` to context-bridge.ts |
| 2026-02-07 | Pre-PRD | Renamed `OTEL_TRACE_CONTENT_ENABLED` → `OTEL_CAPTURE_AI_PAYLOADS` |
| 2026-02-07 | Pre-PRD | Confirmed INPUT shows in Datadog (as raw JSON), OUTPUT missing |
| 2026-02-07 | PRD created | Defined 5 milestones with research-first approach |
| 2026-02-07 | M1 complete | Research doc created; identified extended thinking as root cause of empty completions and CLI finalAnswer failure; no upstream issue exists for OpenLLMetry-JS standard API + thinking; decided to disable extended thinking first |
