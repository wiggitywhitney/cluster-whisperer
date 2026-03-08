# PRD #50: Choose Your Own Adventure Abstract Rewrite

**Status**: Not Started
**Priority**: Medium
**Dependencies**: None (but benefits from demo flow clarity in docs/choose-your-adventure-demo.md)
**Execution Order**: 1 of 5 — Do first. Sharpens the narrative before building anything.
**Branch**: N/A (docs-only, committed to main)

## Problem

The current abstract in `docs/project-state.md` is a placeholder that doesn't reflect
the refined demo flow: the progressive capability narrative (no agent → agent with
kubectl → agent with semantic search + deploy → observability), the audience voting
mechanic, or the core message that the pattern matters more than the technology choices.

## Solution

Rewrite the abstract through interactive back-and-forth with Whitney. This is a
collaborative writing task requiring multiple rounds of feedback, not a one-shot
implementation.

## Success Criteria

- Abstract accurately reflects the demo flow documented in `docs/choose-your-adventure-demo.md`
- Whitney approves the final version
- Abstract conveys the three-vote interactive format
- Abstract conveys the "pattern over technology" message
- Abstract is concise enough for a conference submission (typically 150-300 words)

## Non-Goals

- Rewriting the May conference abstract (that talk is already accepted)
- Marketing copy or promotional material
- Session outline or slide deck

## Milestones

### M1: Interactive Abstract Draft
- [ ] Review current abstract and demo flow document
- [ ] Draft initial abstract capturing the progressive capability narrative
- [ ] Iterate with Whitney through back-and-forth feedback
- [ ] Final version approved by Whitney

### M2: Update Documentation
- [ ] Update `docs/project-state.md` with the new abstract
- [ ] Update `docs/choose-your-adventure-demo.md` if the abstract crystallizes any narrative changes

## Context

### Current Abstract (placeholder)
> A hero app lives in a Kubernetes cluster supported by an Internal Developer Platform.
> Developers want more: can AI make their experience smoother? The audience votes on AI
> tooling choices at three decision points.

### Demo Narrative to Capture
1. Developer's app is broken, they have no cluster access
2. Give them an agent (Vote 1: LangGraph or Vercel) — now they can investigate
3. Agent hits a wall: 1,200+ CRDs and no understanding of what they do
4. Give the agent semantic search (Vote 2: Chroma or Qdrant) — now it finds the right database and deploys it
5. Show what the agent did via traces (Vote 3: Jaeger or Datadog)
6. Punchline: the technology choice didn't matter — the pattern works regardless

### Key Messages
- AI agents are a powerful new platform interface for developers
- The pattern (agent + curated tools + semantic search + observability) is what matters
- The underlying technology is interchangeable — that's the point
- Platform teams control what the agent can do — guardrails through tool design

## Decision Log

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-03-07 | Separate PRD for abstract | Requires interactive back-and-forth, different workflow than implementation PRDs |
