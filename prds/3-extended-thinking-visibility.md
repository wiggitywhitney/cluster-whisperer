# PRD #3: Extended Thinking Visibility

**Status**: In Progress (M1 Complete)
**Priority**: Medium
**Created**: 2026-01-20
**Last Updated**: 2026-01-20

---

## Problem Statement

The cluster-whisperer CLI shows tool calls (kubectl_get, kubectl_describe, kubectl_logs) but not Claude's reasoning process. Users see *what* the agent does, but not *why* it makes each decision. This limits:

1. **Learning value** - Users can't see how an AI agent thinks through problems
2. **Debugging** - When the agent makes poor choices, there's no visibility into why
3. **Trust** - Users must trust the agent's decisions without seeing the reasoning

## Proposed Solution

Enable Claude's "extended thinking" feature and stream the thinking content to the terminal. Users would see the agent's reasoning interleaved with tool calls:

```bash
$ cluster-whisperer "Why are pods failing in the payments namespace?"

🤔 Thinking: I need to start by listing pods in the payments namespace to see their status...

🔧 Tool: kubectl_get
   Args: {"resource":"pods","namespace":"payments"}
   Result: payments-api-7d4f9-x2k  0/1  CrashLoopBackOff  5

🤔 Thinking: The pod is in CrashLoopBackOff. I should check the events to understand why it's restarting...

🔧 Tool: kubectl_describe
   ...
```

## Success Criteria

- [ ] Extended thinking is enabled and working
- [ ] Thinking content streams to terminal with clear visual distinction from tool calls
- [ ] Implementation is based on official documentation, not guesswork
- [ ] Documentation updated to explain the feature

---

## Milestones

### M1: Research Phase
**Goal**: Understand exactly how extended thinking works from official docs

- [x] Review Anthropic's extended thinking documentation
- [x] Review LangChain.js ChatAnthropic source code for thinking support
- [x] Understand event stream structure for thinking content
- [x] Document findings: configuration options, event format, constraints
- [x] Identify any limitations (temperature requirements, token budgets, etc.)

**Deliverable**: Research notes documenting exactly how to implement this

### M2: Implementation
**Goal**: Enable extended thinking and display it in the CLI

- [ ] Update ChatAnthropic configuration to enable thinking
- [ ] Add event handler for thinking content in the stream loop
- [ ] Display thinking with visual distinction (emoji, formatting)
- [ ] Test with various questions to verify thinking appears

**Deliverable**: Working CLI that shows thinking alongside tool calls

### M3: Polish & Documentation
**Goal**: Refine the UX and document the feature

- [ ] Tune thinking budget for good balance of insight vs. verbosity
- [ ] Update docs/agentic-loop.md to explain thinking visibility
- [ ] Update README if needed
- [ ] Test edge cases (long thinking, streaming interruption)

**Deliverable**: Feature complete and documented

---

## Technical Notes

### Configuration (Confirmed)

**ChatAnthropic Setup:**
```typescript
const model = new ChatAnthropic({
  model: "claude-sonnet-4-20250514",
  maxTokens: 10000,  // Must be > budget_tokens
  thinking: { type: "enabled", budget_tokens: 4000 },
  // Note: temperature must NOT be set (defaults handled by API)
});
```

**Critical Constraints:**
- `budget_tokens` minimum: **1,024 tokens**
- `budget_tokens` must be less than `max_tokens`
- Extended thinking is **NOT compatible** with:
  - `temperature` modifications (remove our current `temperature: 0`)
  - `top_p` / `top_k` modifications
  - Forced tool use (only `tool_choice: any` works)
  - Response pre-filling

**Supported Models:**
- Claude Sonnet 4 / 4.5
- Claude Opus 4 / 4.5
- Claude Haiku 4.5
- Claude 3.7 Sonnet

### Streaming Event Structure (Confirmed)

**Raw API Events (what Anthropic sends):**
```
content_block_start  → {"type": "thinking"}
content_block_delta  → {"type": "thinking_delta", "thinking": "Let me analyze..."}
content_block_delta  → {"type": "signature_delta", "signature": "..."}
content_block_stop
content_block_start  → {"type": "text"}
content_block_delta  → {"type": "text_delta", "text": "Based on my analysis..."}
```

**LangChain Processing:**
- Thinking arrives in `AIMessageChunk.content` array with `type: "thinking"`
- In `on_chat_model_end` event, thinking blocks appear in `output.content[]`
- Current code filters for `block.type === "text"` - need to also handle `block.type === "thinking"`

### Implementation Approach

**Option 1: Handle in `on_chat_model_end`**
- Thinking blocks appear in `output.content` array alongside text blocks
- Filter for `type === "thinking"` and display with 🤔 prefix
- Simple but thinking appears after tool results, not before

**Option 2: Handle via `on_llm_stream` events**
- Get thinking tokens as they stream
- More complex but shows thinking in real-time before tool calls
- May have issues with tool binding (see LangGraph issue #253)

**Recommendation:** Start with Option 1 for simplicity, iterate if needed.

### Tool Use Integration

When using extended thinking with tools:
1. Thinking blocks must be preserved and passed back to the API
2. When sending tool results, include complete thinking blocks from previous response
3. LangChain/LangGraph should handle this automatically via `createReactAgent`

### Budget Token Recommendations

| Use Case | Budget | Rationale |
|----------|--------|-----------|
| Simple queries | 1,024 | Minimum, quick responses |
| Investigation | 4,000 | Good balance for multi-step reasoning |
| Complex analysis | 8,000+ | Deep reasoning, may timeout |

For cluster-whisperer: Start with **4,000** tokens - investigation tasks benefit from visible reasoning.

### Open Questions (Answered)

| Question | Answer |
|----------|--------|
| Event structure in streamEvents() | Thinking in AIMessageChunk.content array, type: "thinking" |
| How thinking interleaves with tools | Thinking happens before each tool call decision |
| Recommended budget_tokens | 4,000 for investigation use case |
| Interaction with createReactAgent | Should work - LangChain preserves thinking blocks automatically |

### Notes

- **Claude 4 vs 3.7**: Claude 4 returns summarized thinking, Claude 3.7 returns full thinking. We're on Claude Sonnet 4 so will get summaries.

---

## Design Decisions

*To be filled in during implementation*

---

## Progress Log

### 2026-01-20
- PRD created
- Feature identified during PRD #1 completion workflow
- M1 Research completed:
  - Reviewed Anthropic extended thinking documentation
  - Reviewed LangChain.js ChatAnthropic source code
  - Documented configuration, constraints, and streaming event structure
  - Created standalone docs: `docs/extended-thinking-research.md`, `docs/langgraph-vs-langchain.md`
  - Key finding: Must remove `temperature: 0` setting, use `budget_tokens: 4000`

---

## References

- [Anthropic Extended Thinking Docs](https://docs.anthropic.com/en/docs/build-with-claude/extended-thinking)
- [LangChain.js ChatAnthropic source](https://github.com/langchain-ai/langchainjs/blob/main/libs/langchain-anthropic/src/chat_models.ts)
- PRD #1 implementation (baseline CLI)
