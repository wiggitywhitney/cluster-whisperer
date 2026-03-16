# M1 Research Summary: Vercel AI SDK for Cluster Whisperer

Research conducted 2026-03-16 for PRD #49 (Vercel AI SDK Agent Implementation).

## Q1: Agent API — ToolLoopAgent vs streamText

### ToolLoopAgent (Recommended by Vercel for AI SDK 6)

`ToolLoopAgent` is a class-based agent that wraps `streamText`/`generateText` with a tool
execution loop. Default 20 steps, configurable via `stopWhen: stepCountIs(N)`.

```typescript
import { ToolLoopAgent, stepCountIs, tool } from 'ai';

const agent = new ToolLoopAgent({
  model: anthropic('claude-sonnet-4-20250514'),
  tools: { ... },
  stopWhen: stepCountIs(50),
});

// Non-streaming
const result = await agent.generate({ prompt: 'question' });

// Streaming
const result = agent.stream({ prompt: 'question' });
```

### streamText (Lower-Level)

Direct streaming with multi-step tool execution:

```typescript
import { streamText, stepCountIs } from 'ai';

const result = streamText({
  model: anthropic('claude-sonnet-4-20250514'),
  system: systemPrompt,
  prompt: question,
  tools: filteredTools,
  stopWhen: stepCountIs(50),
  experimental_telemetry: { isEnabled: true },
});
```

### Decision: Use `streamText` directly

Rationale:
- `streamText` provides direct access to `fullStream` with fine-grained stream parts
- `ToolLoopAgent` is a convenience wrapper — for our AgentEvent adapter, we need low-level
  control over the streaming events (reasoning, tool-call, tool-result, step boundaries)
- The PRD's existing code examples use `streamText`, and the LangGraph adapter already does
  low-level event translation — consistency argues for the same approach with Vercel

## Q2: Anthropic Provider — Claude Configuration & Extended Thinking

### Package Version

`@ai-sdk/anthropic` latest is **v3.0.58** (published ~2026-03-07).

### Model Configuration

```typescript
import { anthropic } from '@ai-sdk/anthropic';

const model = anthropic('claude-sonnet-4-20250514');
```

### Extended Thinking — CONFIRMED WORKING

For Claude Sonnet 4 (our model), use `type: 'enabled'` with `budgetTokens`:

```typescript
providerOptions: {
  anthropic: {
    thinking: { type: 'enabled', budgetTokens: 4000 },
  },
},
```

### Interleaved Thinking — CONFIRMED WORKING

Pass the beta header via `providerOptions.anthropic.headers`:

```typescript
providerOptions: {
  anthropic: {
    thinking: { type: 'enabled', budgetTokens: 4000 },
    headers: { 'anthropic-beta': 'interleaved-thinking-2025-05-14' },
  },
},
```

Note: There was a bug (vercel/ai#10018) where custom `anthropic-beta` headers were
overwritten by auto-detected beta headers. This was fixed in PR #10158 — the fix merges
comma-separated beta values. Ensure `@ai-sdk/anthropic` is recent enough to include this fix.

### Claude 4.6 vs Claude 4 Thinking

- **Claude 4.6** (opus-4-6, sonnet-4-6): Use `thinking: { type: 'adaptive' }` (automatic)
- **Claude 4** (sonnet-4, opus-4): Use `thinking: { type: 'enabled', budgetTokens: N }` (manual)

Our agent uses `claude-sonnet-4-20250514` which is Claude Sonnet 4, so we use the manual
`type: 'enabled'` approach. This matches the LangGraph agent's configuration.

### Summarized Thinking

Claude 4 models return **summarized** thinking output, not full thinking tokens. You're
charged for full thinking tokens, but the response contains a condensed summary. This is
the same behavior as the LangGraph agent (LangChain uses the same Anthropic API).

## Q3: Streaming Event Model for AgentEvent Adapter

### fullStream Part Types

The `streamText` result exposes a `fullStream` property — an `AsyncIterable<TextStreamPart>`
that emits all events during a multi-step agent run. SDK 6 uses a start/delta/end pattern:

**Complete part type list (SDK 6):**

| Category | Part Types |
|----------|-----------|
| Lifecycle | `start`, `start-step`, `finish-step`, `finish` |
| Text | `text-start`, `text-delta`, `text-end` |
| Reasoning | `reasoning-start`, `reasoning-delta`, `reasoning-end` |
| Tool input | `tool-input-start`, `tool-input-delta`, `tool-input-end` |
| Tool execution | `tool-call`, `tool-result`, `tool-error` |
| Other | `source`, `file`, `error`, `raw` (opt-in) |

Note: SDK 6 renamed `tool-call-streaming-start`/`tool-call-delta` to
`tool-input-start`/`tool-input-delta`.

**Key parts for AgentEvent mapping:**

| Part Type | Fields | Maps To AgentEvent |
|-----------|--------|--------------------|
| `'reasoning-delta'` | `text: string` (runtime; types may say `delta` — see vercel/ai#8756) | `{ type: "thinking", content }` — accumulate deltas |
| `'tool-call'` | `toolCallId, toolName, input` | `{ type: "tool_start", name, args }` |
| `'tool-result'` | `toolCallId, toolName, output` | `{ type: "tool_result", content }` |
| `'text-delta'` | `text: string` (runtime; types may say `delta` — see vercel/ai#8756) | `{ type: "final_answer", content }` — accumulate for last step |
| `'finish-step'` | `finishReason, usage, stepType` | (detect final step for final_answer) |

**Property name caution**: The `tool-call` part uses `input` (not `args`) and `tool-result`
uses `output` (not `result`) in SDK 6. The `reasoning-delta` and `text-delta` parts use
`text` at runtime for the incremental text (not `delta` as the provider-level types suggest).
This is a known inconsistency (vercel/ai#8756) between provider-level types and consumer-level
runtime. The implementation uses `part.text` — verified during M5 implementation.

### AgentEvent Translation Strategy

```typescript
for await (const part of result.fullStream) {
  switch (part.type) {
    case 'reasoning-delta':
      yield { type: 'thinking', content: part.text };
      break;
    case 'tool-call':
      yield { type: 'tool_start', name: part.toolName, args: part.input };
      break;
    case 'tool-result':
      yield { type: 'tool_result', content: String(part.output) };
      break;
    case 'text-delta':
      // Accumulate text deltas; emit final_answer when step finishes without tool calls
      textBuffer += part.text;
      break;
    case 'finish-step':
      if (part.finishReason === 'stop' && textBuffer) {
        yield { type: 'final_answer', content: textBuffer };
        textBuffer = '';
      }
      break;
  }
}
```

### Lifecycle Callbacks (Alternative)

AI SDK 6 also provides callbacks that fire during streaming:
- `experimental_onStart` — called once when streamText begins
- `experimental_onStepStart` — called before each step (LLM call)
- `experimental_onToolCallStart` — called before tool execute runs
- `experimental_onToolCallFinish` — called after tool execute, with `durationMs`
- `onStepFinish` — called after each step completes

These are supplementary to `fullStream` — the stream parts are sufficient for our adapter.

### Reasoning Delta Property

**Watch out**: There is a known inconsistency (vercel/ai#8756) between provider-level
types and consumer-level runtime for the text property on `reasoning-delta` and `text-delta`
parts. The provider-level `LanguageModelV2StreamPart` types say `delta`, but runtime uses
`text`. Verified during M5 implementation — the AgentEvent adapter uses `part.text`.

## Q4: experimental_telemetry Span Compatibility with OTLP

### Span Names — CONFIRMED from docs

| Span Name | Type | Key Attributes |
|-----------|------|----------------|
| `ai.streamText` | Outer span (full multi-step call) | `ai.model.id`, `ai.usage.*`, `ai.response.text` |
| `ai.streamText.doStream` | Inner LLM call (per step) | `gen_ai.system`, `gen_ai.request.model`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens` |
| `ai.toolCall` | Tool execution | `ai.toolCall.name`, `ai.toolCall.args`, `ai.toolCall.result` |

The inner `doStream` span carries **gen_ai.*** semantic convention attributes — this is
what Datadog LLM Observability recognizes for token usage dashboards.

### Custom Tracer for Context Propagation

`experimental_telemetry` accepts a `tracer` parameter:

```typescript
experimental_telemetry: {
  isEnabled: true,
  functionId: 'cluster-whisperer-investigate',
  tracer: tracerProvider.getTracer('ai'),
}
```

This is critical for our use case: we can pass a tracer from our existing TracerProvider
to ensure Vercel SDK spans nest under our root `cluster-whisperer.cli.investigate` span.
If we don't pass a custom tracer, the SDK uses the `@opentelemetry/api` global singleton.

### OTLP Compatibility

The SDK uses standard OpenTelemetry APIs. Spans created by `experimental_telemetry` are
exported through whatever TracerProvider is registered — our existing OTLP setup
(`src/tracing/index.ts`) should work without changes.

### functionId and Metadata

```typescript
experimental_telemetry: {
  isEnabled: true,
  functionId: 'cluster-whisperer-investigate',  // Identifies our function
  metadata: { agent: 'vercel' },                // Custom attributes on spans
}
```

## Q5: Extended Thinking with Interleaved Thinking

**CONFIRMED**: The AI SDK Anthropic provider fully supports extended thinking with
interleaved thinking between tool calls. See Q2 for configuration details.

The `fullStream` emits `reasoning-delta` parts between tool calls when interleaved thinking
is enabled. These parts deliver incremental reasoning text via the `text` property at runtime
(the provider-level types may say `delta` — see vercel/ai#8756).

`result.reasoningText` gives the aggregated reasoning text across all steps (available
after the stream completes). For real-time CLI output, use the stream parts.

## Q6: Conversation History Handling

### Message Format

AI SDK uses `ModelMessage[]` for multi-turn conversations:

```typescript
type ModelMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string | Array<TextPart | ImagePart | FilePart> }
  | { role: 'assistant'; content: string | Array<TextPart | ToolCallPart> }
  | { role: 'tool'; content: Array<ToolResultPart> };
```

### Content Part Types for Serialization

```typescript
// Assistant tool call (SDK 6: uses 'args' at ModelMessage level)
{ type: 'tool-call', toolCallId: string, toolName: string, args: object }

// Tool result (SDK 6: uses 'output', renamed from 'result' in SDK 5)
{ type: 'tool-result', toolCallId: string, toolName: string, output: unknown, isError?: boolean }
```

Note: The field names differ between layers — `fullStream` tool-call parts use `input`,
but `ModelMessage` ToolCallPart uses `args`. Similarly, `fullStream` tool-result uses
`output`, and `ModelMessage` ToolResultPart also uses `output` (renamed from `result` in
SDK 5→6). Verify actual field names against TypeScript types during implementation.

### Getting Full Message History After a Run

After `streamText` completes, `response.messages` returns `ModelMessage[]` — the exact
format needed to pass back as `messages` input on the next turn:

```typescript
const result = streamText({ model, messages, tools, ... });

// Wait for completion (response is a promise for streamText)
const response = await result.response;

// response.messages contains ALL assistant + tool messages from ALL steps
const newMessages = response.messages;

// Append to existing conversation
allMessages.push(...newMessages);

// Serialize for next invocation
fs.writeFileSync(threadFile, JSON.stringify(allMessages));
```

### Resuming Conversation

```typescript
// Load prior messages
const priorMessages = JSON.parse(fs.readFileSync(threadFile, 'utf8'));

// Pass as messages parameter
const result = streamText({
  model,
  system: systemPrompt,
  messages: [
    ...priorMessages,
    { role: 'user', content: newQuestion },
  ],
  tools,
  ...
});
```

## Gotchas and Surprises

1. **`inputSchema` not `parameters`**: AI SDK 6's `tool()` uses `inputSchema` for Zod schemas,
   not the older `parameters` field. The PRD pre-research already caught this.

2. **Reasoning property renamed**: In AI SDK 5→6, `.reasoning` was renamed to `.reasoningText`
   on results. Stream parts use `text` at runtime for incremental text (types may say `delta` — see #8756).

3. **anthropic-beta header merging**: Fixed bug in Anthropic provider — custom beta headers
   are now properly merged (comma-separated) rather than overwritten. Ensure recent version.

4. **Tool definition uses objects, not arrays**: `tools` parameter is `Record<string, Tool>`,
   not an array. Tool names are the object keys.

5. **No built-in persistence**: No equivalent to LangGraph's `MemorySaver`. Message history
   management is manual (serialize/deserialize `ModelMessage[]`).

6. **`ai.toolCall` spans are SDK-generated**: The SDK creates its own tool execution spans.
   Our `withToolTracing()` wrapper also creates tool spans. Need to verify these don't
   conflict (double-spanning). If they do, we may need to disable the SDK's `ai.toolCall`
   spans or remove our wrapper for Vercel tools.

7. **SDK 6 renames**: `system` → `instructions` (but `system` may still work as alias),
   `maxSteps` → `stopWhen: stepCountIs(N)`, `CoreMessage` → `ModelMessage`,
   `ToolCallOptions` → `ToolExecutionOptions`. Default step count changed from 1 to 20.
   An automated codemod is available: `npx @ai-sdk/codemod v6`.

8. **`gen_ai.*` attributes only on call-level spans**: The `gen_ai.system`,
   `gen_ai.request.model`, `gen_ai.usage.*` attributes are on `doStream`/`doGenerate` spans,
   NOT on the top-level `ai.streamText` or `ai.toolCall` spans. This matters for Datadog
   LLM Observability — it reads `gen_ai.*` from the inner spans.

9. **`functionId` sets span `resource.name`**: When `functionId` is provided,
   `operation.name` becomes `ai.streamText cluster-whisperer-investigate`. This is useful
   for filtering in Datadog.

## PRD Impact Assessment

No changes needed to the PRD Technical Design section. All pre-research findings are confirmed:

| Pre-Research Claim | Status | Notes |
|--------------------|--------|-------|
| ToolLoopAgent exists | CONFIRMED | Class with .generate() and .stream() |
| Extended thinking works | CONFIRMED | `type: 'enabled', budgetTokens: 4000` |
| Interleaved thinking works | CONFIRMED | Via `anthropic-beta` header |
| Tool API uses inputSchema | CONFIRMED | Not `parameters` |
| Telemetry span names | CONFIRMED | ai.streamText, ai.streamText.doStream, ai.toolCall |
| No built-in conversation memory | CONFIRMED | Manual message array management |

### New Information for Implementation

1. Use `streamText` directly (not `ToolLoopAgent`) for better streaming control
2. `fullStream` part type `'reasoning-delta'` maps to thinking blocks (use `part.text` at runtime — verified, see #8756)
3. `experimental_telemetry.tracer` parameter enables custom TracerProvider — critical for
   span nesting under our root span
4. Watch for double tool spans (our `withToolTracing` + SDK's `ai.toolCall`)
5. `tools` parameter is `Record<string, Tool>` not `Tool[]`
