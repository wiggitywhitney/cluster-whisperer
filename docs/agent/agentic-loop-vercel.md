# The Agentic Loop (Vercel AI SDK)

This guide explains how cluster-whisperer implements the agentic investigation loop using the Vercel AI SDK. For the same concepts explained through LangGraph, see [agentic-loop-langgraph.md](./agentic-loop-langgraph.md).

---

## The Same Pattern, Different Framework

Both agents implement the same ReAct pattern (Reason + Act). The agent thinks about what to do, calls a tool, observes the result, and repeats until it has an answer. The difference is in the machinery that runs the loop.

| Concept | LangGraph | Vercel AI SDK |
|---------|-----------|---------------|
| Loop runner | `createReactAgent()` | `streamText()` with tools |
| Event stream | `agent.streamEvents()` | `result.fullStream` |
| Step limit | `recursionLimit` at invoke time | `stopWhen: stepCountIs(50)` |
| System prompt | `stateModifier` option | `system` parameter |
| Tool format | Array of Tool objects | `Record<string, Tool>` object |

---

## What Parts Are Vercel AI SDK?

Most of our code is plain TypeScript. The Vercel AI SDK provides three key pieces:

### 1. anthropic() Model Provider

A provider function that creates a model instance from `@ai-sdk/anthropic`.

```typescript
import { anthropic } from "@ai-sdk/anthropic";

// That's all — one function that takes a model name
const model = anthropic("claude-sonnet-4-20250514");
```

Unlike LangChain's `ChatAnthropic` class (which accepts thinking config, max tokens, and headers at construction time), the Vercel provider is a thin wrapper. Configuration happens at the `streamText()` call site.

### 2. streamText()

The core function that makes everything work. When you pass tools to `streamText()`, it automatically becomes an agentic loop — the model can call tools, see results, and keep going until it produces a final text answer.

```typescript
import { streamText, stepCountIs } from "ai";

const result = streamText({
  model: anthropic("claude-sonnet-4-20250514"),
  maxOutputTokens: 16000,
  system: systemPrompt,
  prompt: question,
  tools,
  stopWhen: stepCountIs(50),
  providerOptions: {
    anthropic: {
      thinking: { type: "enabled", budgetTokens: 4000 },
      headers: { "anthropic-beta": "interleaved-thinking-2025-05-14" },
    },
  },
});
```

There is no separate `createReactAgent()` step. `streamText()` IS the agent when tools are provided. The loop logic is built into the SDK — it keeps sending tool results back to the model until the model produces text without tool calls.

**Extended Thinking** is configured via `providerOptions.anthropic` rather than on the model directly. The `interleaved-thinking-2025-05-14` beta header enables Claude to reason between every tool call, not just at the start.

### 3. tool()

A helper from the `ai` package that defines a tool with its schema and execute function.

```typescript
import { tool } from "ai";

const kubectl_get = tool({
  description: "List Kubernetes resources...",
  inputSchema: kubectlGetSchema,    // Zod schema
  execute: async (input) => { ... },
});
```

Key differences from LangChain's `tool()`:
- Uses `inputSchema` (not `schema` or `parameters`) — this is the SDK 6 convention
- Returns tools as an object with names as keys: `{ kubectl_get: tool(...) }`
- LangChain returns tools as arrays with a `name` property on each tool

Everything else — the tools themselves, the kubectl execution, the CLI — is plain TypeScript.

---

## Streaming Events

### Why Stream?

`streamText()` returns a `result` object with a `fullStream` async iterable. Instead of waiting for the agent to finish, you watch it work in real time.

### Event Types

The `fullStream` produces typed parts. Here are the ones we care about:

#### `reasoning-delta`
**When**: Claude is thinking between steps (extended thinking enabled).

```typescript
case "reasoning-delta":
  // part.text contains a fragment of Claude's reasoning
  thinkingBuffer += part.text;
```

**SDK 6 note**: The property is `part.text`, not `part.delta`. There's a known inconsistency (vercel/ai#8756) where delta properties are named differently across API layers.

#### `tool-call`
**When**: The model decided to call a tool.

```typescript
case "tool-call":
  // part.toolName — which tool (e.g., "kubectl_get")
  // part.input — the arguments the model chose
```

**SDK 6 note**: The property is `part.input`, not `part.args`.

#### `tool-result`
**When**: A tool finished executing and returned a result.

```typescript
case "tool-result":
  // part.toolName — which tool produced this
  // part.output — the tool's return value
```

**SDK 6 note**: The property is `part.output`, not `part.result`.

#### `text-delta`
**When**: The model is producing its final text answer.

```typescript
case "text-delta":
  // part.text — a fragment of the final answer
  textBuffer += part.text;
```

#### `finish-step`
**When**: A step in the agentic loop completed.

```typescript
case "finish-step":
  if (part.finishReason === "stop" && textBuffer) {
    // Model produced a final answer — investigation complete
  } else {
    // Model called tools — loop continues to next step
    textBuffer = "";
  }
```

The `finishReason` tells you why the step ended:
- `"stop"` — model chose to stop (has enough information to answer)
- `"tool-calls"` — model wants to call more tools (loop continues)

### Putting It Together

```text
User asks question
    ↓
[reasoning-delta] → thinking: "I should check pods first..."
    ↓
[tool-call] → kubectl_get with { resource: "pods", namespace: "all" }
    ↓
[tool-result] → kubectl_get returned pod listing
    ↓
[finish-step] → finishReason: "tool-calls" (loop continues)
    ↓
[reasoning-delta] → thinking: "I see a CrashLoopBackOff pod..."
    ↓
[tool-call] → kubectl_describe with { resource: "pod", name: "demo-app-xxx" }
    ↓
[tool-result] → kubectl_describe returned pod details
    ↓
[finish-step] → finishReason: "tool-calls" (loop continues)
    ↓
[reasoning-delta] → thinking: "Found the issue..."
    ↓
[text-delta] → "Your app is broken because..."
    ↓
[finish-step] → finishReason: "stop" (done!)
    ↓
Final answer displayed
```

### Buffering Strategy

The `fullStream` delivers thinking and text as small fragments (deltas). We buffer these and flush at transition points to produce clean, complete events for the CLI:

```typescript
let textBuffer = "";
let thinkingBuffer = "";

for await (const part of result.fullStream) {
  switch (part.type) {
    case "reasoning-delta":
      thinkingBuffer += part.text;
      break;

    case "tool-call":
      // Flush thinking before yielding the tool call
      if (thinkingBuffer) {
        yield { type: "thinking", content: thinkingBuffer };
        thinkingBuffer = "";
      }
      yield { type: "tool_start", toolName: part.toolName, args: part.input };
      break;

    // ... more cases
  }
}
```

This produces one `ThinkingEvent` per thought block (matching LangGraph's behavior) instead of dozens of tiny fragments.

---

## The System Prompt

Both agents share the same system prompt file (`prompts/investigator.md`). The difference is how it reaches the model.

**LangGraph**: `stateModifier` option on `createReactAgent` — prepended to every conversation.

**Vercel AI SDK**: `system` parameter on `streamText()` — a dedicated field, not injected into the messages array.

```typescript
const result = streamText({
  model: anthropic(ANTHROPIC_MODEL),
  system: systemPrompt,        // ← separate from messages
  prompt: question,             // ← the user's question
  tools,
  // ...
});
```

This separation is cleaner — the system prompt never mixes with conversation history, even in multi-turn mode.

---

## Multi-Turn Memory

The Vercel agent uses file-backed JSON for conversation persistence.

### How It Works

1. **Load**: Read prior `ModelMessage[]` from `data/threads/vercel-<threadId>.json`
2. **Build**: Prepend prior messages to the new user question
3. **Run**: Call `streamText()` with `messages` (multi-turn) instead of `prompt` (single-turn)
4. **Save**: After the stream completes, write the full history back to disk

```typescript
// Single-turn (no memory)
streamText({ prompt: question, ... });

// Multi-turn (with memory)
streamText({ messages: [...priorMessages, { role: "user", content: question }], ... });
```

### Why JSON Files?

LangGraph's `MemorySaver` uses binary serialization with base64-encoded Uint8Arrays. The Vercel agent stores plain `ModelMessage[]` as human-readable JSON. This means you can inspect conversation history directly:

```bash
cat data/threads/vercel-demo.json | jq '.[].role'
```

Thread files use a `vercel-` prefix to avoid collision with LangGraph files in the same directory.

---

## The Shared Interface

Both agents implement `InvestigationAgent`:

```typescript
interface InvestigationAgent {
  investigate(
    question: string,
    options?: InvestigateOptions
  ): AsyncGenerator<AgentEvent>;
}
```

The CLI calls `investigate()` and consumes `AgentEvent` objects. It never knows which framework is running underneath. This is what makes the `$agent vercel` / `$agent langgraph` CLI switch possible — same output, different engines.

The four `AgentEvent` types map to the visible CLI experience:
- `thinking` → Claude's reasoning (displayed in italic)
- `tool_start` → agent decided to call a tool (🔧 prefix)
- `tool_result` → tool returned a result (indented output)
- `final_answer` → agent's conclusion (after ─── separator)
