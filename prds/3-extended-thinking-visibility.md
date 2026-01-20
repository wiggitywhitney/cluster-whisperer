# PRD #3: Extended Thinking Visibility

**Status**: Not Started
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

- [ ] Review Anthropic's extended thinking documentation
- [ ] Review LangChain.js ChatAnthropic source code for thinking support
- [ ] Understand event stream structure for thinking content
- [ ] Document findings: configuration options, event format, constraints
- [ ] Identify any limitations (temperature requirements, token budgets, etc.)

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

### What We Know
- `@langchain/anthropic` has a `thinking` config option
- Configuration: `thinking: { type: "enabled", budget_tokens: N }`
- Temperature must be set to 1 (not 0) for thinking to work
- Thinking content arrives via `thinking_delta` events when streaming

### Open Questions (M1 will answer)
- Exact event structure in LangGraph's `streamEvents()`
- How thinking interleaves with tool calls
- Recommended budget_tokens for this use case
- Any interaction with createReactAgent

---

## Design Decisions

*To be filled in during implementation*

---

## Progress Log

### 2026-01-20
- PRD created
- Feature identified during PRD #1 completion workflow

---

## References

- [Anthropic Extended Thinking Docs](https://docs.anthropic.com/en/docs/build-with-claude/extended-thinking)
- [LangChain.js ChatAnthropic source](https://github.com/langchain-ai/langchainjs/blob/main/libs/langchain-anthropic/src/chat_models.ts)
- PRD #1 implementation (baseline CLI)
