# PRD #49: Vercel AI SDK Agent Implementation

**Status**: Not Started
**Priority**: High
**Dependencies**: PRD #48 (cluster-whisperer modifications — shared tool core, --agent flag)
**Branch**: `feature/prd-49-vercel-agent`

## Problem

The "Choose Your Own Adventure" demo's first audience vote is between agent frameworks:
LangGraph or Vercel AI SDK. The existing agent is built with LangGraph. A second agent
implementation using the Vercel AI SDK is needed so both options work during the demo.

Both agents must produce equivalent investigation experiences — the same tools, same
investigation quality, same reasoning visibility. The framework is an implementation
detail; the pattern is the point.

## Solution

Build a Vercel AI SDK agent using the `ToolLoopAgent` (AI SDK 6) that:
- Shares the existing tool core (`src/tools/core/`) via a new `src/tools/vercel/` wrapper layer
- Uses Claude as the LLM (same model as the LangGraph agent)
- Loads the same system prompt (`prompts/investigator.md`)
- Streams reasoning and tool calls to the CLI (same visible thinking experience)
- Has built-in OTel instrumentation via the SDK's native `experimental_telemetry`
- Plugs into the `--agent vercel` CLI flag (plumbed in PRD #48 M4)

## Success Criteria

- `cluster-whisperer --agent vercel --tools kubectl "Why is my app broken?"` produces an investigation equivalent to the LangGraph agent
- The Vercel agent uses the same tool core functions as the LangGraph agent
- CLI output shows visible reasoning (thinking, tool calls, observations) — same experience as LangGraph
- OTel traces appear in Jaeger/Datadog with spans for LLM calls and tool executions
- The agent handles the full demo flow: investigate → discover missing DB → semantic search → deploy
- Existing LangGraph tests and behavior are unaffected

## Non-Goals

- Feature parity with every LangGraph capability (extended thinking, interleaved thinking)
- MCP tool wrapper for the Vercel agent (demo uses CLI only)
- Production deployment of the Vercel agent
- Performance optimization or benchmarking between agents

## Milestones

### M1: Research Phase
- [ ] Use `/research` to investigate AI SDK 6's `ToolLoopAgent` API, current tool definition patterns, and streaming behavior
- [ ] Use `/research` to investigate AI SDK 6's Anthropic provider — how to configure Claude, extended thinking support, model parameters
- [ ] Verify: can AI SDK 6 stream intermediate reasoning and tool calls to stdout (needed for CLI visibility)?
- [ ] Verify: does `experimental_telemetry` create spans compatible with our OTLP exporter setup?
- [ ] Document findings and any gotchas in a research summary
- [ ] Decision: confirm or adjust the implementation approach based on findings

### M2: Vercel Tool Wrappers
- [ ] `src/tools/vercel/` wrapper layer converting core tools to Vercel AI SDK `tool()` format
- [ ] Each tool: Zod input schema, description, execute function calling core logic
- [ ] Verified: tool definitions are valid and accepted by the AI SDK
- [ ] Unit tests for wrapper conversion

### M3: Vercel Agent Implementation
- [ ] `src/agent/vercel.ts` — agent using `ToolLoopAgent` or `generateText` with `maxSteps`
- [ ] Same system prompt as LangGraph agent (`prompts/investigator.md`)
- [ ] Same Claude model configuration (claude-sonnet-4, etc.)
- [ ] Tool-set filtering support (receives filtered tool array from CLI, same as LangGraph)
- [ ] Agent factory integration (PRD #48 M4's `--agent vercel` flag activates this)

### M4: CLI Streaming Output
- [ ] Stream reasoning, tool calls, and observations to stdout during investigation
- [ ] Match the visual format of the LangGraph agent's CLI output (thinking blocks, tool call displays)
- [ ] The audience should not be able to tell which agent is running from the output format alone

### M5: OTel Instrumentation
- [ ] Enable `experimental_telemetry: { isEnabled: true }` on all AI SDK calls
- [ ] Verify spans: `ai.generateText`, `ai.toolCall` appear in traces
- [ ] Verify spans export to OTLP endpoint (Jaeger/Datadog)
- [ ] Compare trace structure with LangGraph agent traces — both should tell a readable investigation story
- [ ] Note: the Vercel SDK's built-in OTel should NOT need the AsyncLocalStorage context bridge workaround that LangGraph required

### M6: Equivalence Testing
- [ ] Run both agents against the same demo scenario (broken app, missing DB)
- [ ] Compare investigation quality: both should reach the same conclusions
- [ ] Compare trace output: both should produce meaningful, readable traces
- [ ] Document any behavioral differences between the agents

### M7: Documentation
- [ ] Update README using `/write-docs` to document the Vercel agent and --agent flag

## Technical Design

### Tool Wrapper Pattern

The existing three-layer architecture extends naturally:

```text
src/tools/core/kubectl-get.ts      ← Shared logic (schema, execute, description)
src/tools/langchain/index.ts       ← LangGraph wrappers (existing)
src/tools/vercel/index.ts          ← Vercel AI SDK wrappers (new)
```

Vercel tool definition:
```typescript
import { tool } from 'ai';
import { z } from 'zod';
import { kubectlGetSchema, executeKubectlGet, KUBECTL_GET_DESCRIPTION } from '../core/kubectl-get';

export const kubectlGetTool = tool({
  description: KUBECTL_GET_DESCRIPTION,
  inputSchema: z.object({ /* from core schema */ }),
  execute: async (params) => executeKubectlGet(params),
});
```

### Agent Implementation

```typescript
import { generateText } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';

const result = await generateText({
  model: anthropic('claude-sonnet-4-20250514'),
  system: investigatorPrompt,  // Same prompt as LangGraph
  prompt: question,
  tools: filteredTools,        // From --tools flag
  stopWhen: stepCountIs(10),
  experimental_telemetry: { isEnabled: true, functionId: 'cluster-whisperer-investigate' },
});
```

### Streaming to CLI

The Vercel AI SDK supports streaming via `streamText`. For CLI output, iterate over
the stream and display reasoning, tool calls, and results as they arrive — matching
the format of the LangGraph agent's `streamEvents` output.

### OTel Integration

The Vercel AI SDK creates spans natively:
- `ai.generateText` — full operation span
- `ai.generateText.doGenerate` — individual LLM calls
- `ai.toolCall` — tool execution spans

These export through the standard OTel SDK setup (`src/tracing/index.ts`). No
OpenLLMetry SDK or context bridge needed — the AI SDK handles context propagation
internally.

## Decision Log

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-03-07 | Research phase first | AI SDK 6 is new; `ToolLoopAgent` API may have changed. Verify against current docs before implementation. Use `/research` skill. |
| 2026-03-07 | Share tool core, not tool wrappers | Core logic is framework-agnostic. Each framework gets thin wrappers. |
| 2026-03-07 | CLI only, no MCP | Demo uses CLI for visible reasoning. MCP would hide the agent's thinking. |
| 2026-03-07 | Match CLI output format | Audience shouldn't notice which agent is running. The framework choice is an implementation detail. |
