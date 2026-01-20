# Extended Thinking in Claude: Research Findings

This document summarizes how Claude's extended thinking feature works and how to use it with LangChain.

## What is Extended Thinking?

Extended thinking gives Claude a dedicated space to reason before answering. Instead of jumping straight to an answer, the model can think through the problem step by step in a way that's visible to you.

Without extended thinking:
```
User: Why is my pod failing?
Assistant: The pod is failing because... [answer]
```

With extended thinking:
```
User: Why is my pod failing?
[Thinking: I should first check the pod status, then look at events...]
Assistant: The pod is failing because... [answer]
```

## How to Enable It

Add the `thinking` configuration to your ChatAnthropic model:

```typescript
const model = new ChatAnthropic({
  model: "claude-sonnet-4-20250514",
  maxTokens: 10000,
  thinking: {
    type: "enabled",
    budget_tokens: 4000,
  },
});
```

That's the basic setup. Now for the constraints.

## Constraints You Must Know

### 1. Remove Temperature Setting

Extended thinking does not work with custom temperature values. If you have `temperature: 0` in your config, remove it:

```typescript
// Wrong - will fail
const model = new ChatAnthropic({
  model: "claude-sonnet-4-20250514",
  temperature: 0,  // Remove this
  thinking: { type: "enabled", budget_tokens: 4000 },
});

// Correct
const model = new ChatAnthropic({
  model: "claude-sonnet-4-20250514",
  thinking: { type: "enabled", budget_tokens: 4000 },
});
```

### 2. Budget Tokens Must Be Less Than Max Tokens

The thinking budget is a subset of your max output tokens:

```typescript
// Correct: 4000 < 10000
thinking: { type: "enabled", budget_tokens: 4000 },
maxTokens: 10000,

// Wrong: budget exceeds max
thinking: { type: "enabled", budget_tokens: 15000 },
maxTokens: 10000,
```

### 3. Minimum Budget is 1,024 Tokens

You cannot set a budget below 1,024 tokens. The API will reject it.

### 4. Incompatible with Forced Tool Use

If you're using `tool_choice` to force a specific tool, extended thinking won't work. Only `tool_choice: "any"` is supported.

## Supported Models

Extended thinking works with:
- Claude Sonnet 4 and 4.5
- Claude Opus 4 and 4.5
- Claude Haiku 4.5
- Claude 3.7 Sonnet

## What the Response Looks Like

### API Response Structure

Anthropic's API returns thinking as a content block:

```json
{
  "content": [
    {
      "type": "thinking",
      "thinking": "Let me analyze this step by step...",
      "signature": "abc123..."
    },
    {
      "type": "text",
      "text": "Based on my analysis..."
    }
  ]
}
```

### Streaming Events

When streaming, thinking arrives as delta events:

```
content_block_start  → {"type": "thinking"}
content_block_delta  → {"type": "thinking_delta", "thinking": "..."}
content_block_delta  → {"type": "signature_delta", "signature": "..."}
content_block_stop
```

Then the text response follows.

### In LangChain

LangChain wraps these in `AIMessageChunk` objects. The `content` property is an array:

```typescript
// Inside on_chat_model_end handler
const content = event.data.output.content;
// content = [
//   { type: "thinking", thinking: "..." },
//   { type: "text", text: "..." }
// ]
```

## Tool Use with Extended Thinking

When Claude decides to call a tool while thinking is enabled, the thinking happens first:

1. Claude receives the question
2. Thinking: "I should check the pod status..."
3. Tool call: kubectl_get
4. Tool returns results
5. Thinking: "The pod is in CrashLoopBackOff, I should check logs..."
6. Tool call: kubectl_logs
7. Final answer

The thinking blocks must be preserved when sending tool results back to the API. LangChain's `createReactAgent` handles this automatically.

## Interleaved Thinking (Critical for Agentic Loops)

By default, extended thinking only happens at the **start** of each assistant turn. This means you get one thinking block, then multiple tool calls without any visible reasoning between them.

**To see thinking between every tool call**, you need the `interleaved-thinking-2025-05-14` beta header.

### Without Interleaved Thinking
```
Thinking: "I'll check pods, then describe, then logs..."
Tool: kubectl_get
Tool: kubectl_describe
Tool: kubectl_logs
Answer
```

### With Interleaved Thinking
```
Thinking: "I should start by checking pods..."
Tool: kubectl_get
Thinking: "I see a Pending pod. Let me investigate why..."
Tool: kubectl_describe
Thinking: "Found a node taint issue. Let me check the deployment..."
Tool: kubectl_get deployments
Thinking: "Now I understand the full picture..."
Answer
```

### How to Enable It

Pass the beta header via `clientOptions.defaultHeaders`:

```typescript
const model = new ChatAnthropic({
  model: "claude-sonnet-4-20250514",
  maxTokens: 10000,
  thinking: { type: "enabled", budget_tokens: 4000 },
  clientOptions: {
    defaultHeaders: {
      "anthropic-beta": "interleaved-thinking-2025-05-14",
    },
  },
});
```

### Why This Matters for Learning

Interleaved thinking shows the true agentic loop in action:
- **Reason** → Think about what to do
- **Act** → Call a tool
- **Observe** → See the result
- **Reason again** → Adapt based on what was learned

Without interleaved thinking, you only see the first "Reason" step. With it, you see how the agent adapts its investigation based on each discovery.

## Claude 4 vs Claude 3.7

There's an important difference:
- **Claude 3.7 Sonnet**: Returns full thinking output
- **Claude 4 models**: Returns a summary of the thinking

Both are billed for the full thinking tokens, but Claude 4 gives you a condensed version. This is useful because thinking can be verbose.

## Budget Token Recommendations

| Use Case | Budget | Notes |
|----------|--------|-------|
| Quick questions | 1,024 | Minimum allowed |
| Investigation tasks | 4,000 | Good for multi-step reasoning |
| Complex analysis | 8,000+ | More thorough but slower |

For investigation agents (like cluster-whisperer), 4,000 tokens is a good starting point.

## References

- [Anthropic Extended Thinking Docs](https://docs.anthropic.com/en/docs/build-with-claude/extended-thinking)
- [AWS Bedrock Extended Thinking](https://docs.aws.amazon.com/bedrock/latest/userguide/claude-messages-extended-thinking.html)
- [LangChain ChatAnthropic Docs](https://docs.langchain.com/oss/python/integrations/chat/anthropic)
- [LangGraph Streaming](https://langchain-ai.github.io/langgraphjs/agents/streaming/)
