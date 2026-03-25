# LangGraph vs LangChain

This document explains the difference between LangChain and LangGraph, and when to use each.

## The Short Version

- **LangChain**: A toolkit of components for working with LLMs (model wrappers, prompt templates, tools)
- **LangGraph**: A framework for building agents that make decisions in a loop

Think of LangChain as LEGO bricks. LangGraph is the instruction manual for building a robot that decides which brick to use next.

## LangChain: The Components

LangChain provides building blocks:

```typescript
import { ChatAnthropic } from "@langchain/anthropic";  // Model wrapper
import { HumanMessage } from "@langchain/core/messages"; // Message types
```

These components are useful on their own:
- **ChatAnthropic**: Wraps the Claude API with a consistent interface
- **Message types**: Standardized way to represent conversations
- **Tools**: Define functions the model can call

LangChain components work independently. You can use `ChatAnthropic` without any other LangChain code.

## LangGraph: The Agent Loop

LangGraph builds on LangChain components to create agents - programs that decide what to do next:

```typescript
import { createReactAgent } from "@langchain/langgraph/prebuilt";

const agent = createReactAgent({
  llm: model,      // LangChain component
  tools: [tool1],  // LangChain components
});
```

LangGraph handles the decision loop:
1. Send the question to the model
2. If the model wants to call a tool, call it
3. Feed the result back to the model
4. Repeat until the model has a final answer

Without LangGraph, you'd write this loop yourself.

## Why Both Exist

LangGraph is a separate package because:
1. Not everyone needs agents - some just need to call an LLM
2. Agents are complex enough to warrant their own framework
3. LangGraph can work with components from different providers

They're designed to work together. LangGraph uses LangChain components but adds the orchestration layer.

## In This Codebase

We use both:

```typescript
// LangChain components
import { ChatAnthropic } from "@langchain/anthropic";
import { HumanMessage } from "@langchain/core/messages";

// LangGraph agent builder
import { createReactAgent } from "@langchain/langgraph/prebuilt";
```

The packages:
- `@langchain/anthropic`: Claude-specific model wrapper
- `@langchain/core`: Shared types (messages, tools)
- `@langchain/langgraph`: Agent orchestration

## When to Use What

| Scenario | Use |
|----------|-----|
| Single LLM call, no decisions | LangChain components only |
| Model needs to call tools and iterate | LangGraph agent |
| Custom decision logic | LangGraph with custom graph |
| Just want the Claude API wrapper | `@langchain/anthropic` alone |

## The createReactAgent Shortcut

`createReactAgent` is a pre-built agent pattern. It implements the ReAct loop (Reason + Act):

```text
Question → Think → Act (tool) → Observe (result) → Think → ... → Answer
```

You could build this yourself with LangGraph's graph primitives, but `createReactAgent` handles the common case.

## Package Relationships

```text
@langchain/core          ← Shared foundation (messages, tools, interfaces)
      ↑
@langchain/anthropic     ← Claude-specific implementation
      ↑
@langchain/langgraph     ← Agent orchestration (uses core + providers)
```

Core provides interfaces. Provider packages (anthropic, openai, etc.) implement them. LangGraph orchestrates.
