# The Agentic Loop

This guide explains how we turn tools into an agent that can reason and investigate.

---

## What Makes It "Agentic"?

A regular program follows a fixed path: do step 1, then step 2, then step 3. An agent decides what to do at each step based on what it's learned so far.

```
Regular Program:           Agent:
1. Get pods         →      1. Get pods
2. Describe first   →      2. See CrashLoopBackOff, decide to describe that pod
3. Show logs        →      3. See OOMKilled in events, decide to check logs
4. Return result    →      4. Found the answer, stop and summarize
```

The agent's path emerges from its reasoning, not from our code.

---

## The ReAct Pattern

Our agent uses the ReAct pattern: **Re**ason + **Act**. Each cycle:

1. **Reason**: Look at the question and what we know so far. What should we do next?
2. **Act**: Call a tool (like `kubectl_get`) to get new information
3. **Observe**: See what the tool returned
4. **Repeat**: Go back to step 1 with this new knowledge

The loop continues until the agent has enough information to answer the question.

```
┌─────────────────────────────────────────────────────┐
│                    User Question                     │
└─────────────────────────┬───────────────────────────┘
                          ▼
              ┌───────────────────────┐
              │   Reason: What next?   │◄────────────┐
              └───────────┬───────────┘             │
                          ▼                         │
              ┌───────────────────────┐             │
              │   Act: Call a tool     │             │
              └───────────┬───────────┘             │
                          ▼                         │
              ┌───────────────────────┐             │
              │   Observe: See result  │─────────────┘
              └───────────┬───────────┘
                          ▼
                   Need more info?
                    /          \
                  Yes           No
                   │             │
                   └──► loop     ▼
                              Answer
```

---

## What Parts Are LangChain?

Most of our code is plain TypeScript. LangChain provides two key pieces:

### 1. ChatAnthropic

A wrapper that handles communication with Claude's API.

```typescript
import { ChatAnthropic } from "@langchain/anthropic";

const model = new ChatAnthropic({
  model: "claude-sonnet-4-20250514",
  temperature: 0,  // Deterministic responses
});
```

### 2. createReactAgent

LangGraph's implementation of the ReAct loop. It handles the mechanics of:
- Sending messages to the model
- Detecting when the model wants to call a tool
- Executing the tool and feeding back results
- Knowing when to stop (model produces answer without tool calls)

```typescript
import { createReactAgent } from "@langchain/langgraph/prebuilt";

const agent = createReactAgent({
  llm: model,
  tools: [kubectlGetTool],
  stateModifier: systemPrompt,  // "You are a Kubernetes investigator..."
});
```

Everything else - the tools themselves, the kubectl execution, the CLI - is plain TypeScript.

---

## Streaming Events

Instead of waiting for the agent to finish, we can watch it work in real-time.

### Why Stream?

`agent.invoke()` waits until done, then returns the final result. You don't see what happened along the way.

`agent.streamEvents()` gives you a live feed:
- When the agent decides to call a tool
- What arguments it passes
- What result comes back
- When it's thinking vs acting

This visibility helps you understand how the agent reasons and debug unexpected behavior.

### Event Types

```typescript
const eventStream = agent.streamEvents(
  { messages: [new HumanMessage(question)] },
  { version: "v2" }
);

for await (const event of eventStream) {
  if (event.event === "on_tool_start") {
    // Agent decided to call a tool
    console.log(`Tool: ${event.name}`);
    console.log(`Args: ${JSON.stringify(event.data.input)}`);
  }

  if (event.event === "on_tool_end") {
    // Tool finished, here's the result
    console.log(`Result: ${event.data.output}`);
  }

  if (event.event === "on_chat_model_end") {
    // Model finished generating (might be final answer)
    const content = event.data.output?.content;
  }
}
```

There are many event types (on_chain_start, on_llm_stream, etc.) but these three show the essential flow.

---

## The System Prompt

The system prompt tells the agent how to behave. Ours is minimal - about 10 lines:

```markdown
# Kubernetes Investigation Assistant

You are a Kubernetes cluster investigator. Use the available tools
to answer the user's question about their cluster.

## Investigation Approach

- Start broad, then narrow down to specific problems
- Don't stop at the first result - verify you've found the root cause
- When you find something unhealthy, dig deeper with describe or logs

## Response Format

Provide a clear, concise summary of what you found and what it means.
```

### Why So Short?

The tool descriptions do most of the work. Each tool tells the agent when to use it and what to expect. The system prompt just sets the role and investigation style.

A longer prompt with detailed investigation procedures would conflict with the tool descriptions and make behavior harder to predict.

---

## Putting It Together

```
┌─────────────────────────────────────────────────────────────────┐
│                            CLI                                   │
│                     (src/index.ts)                               │
│                                                                  │
│  1. Parse user's question                                        │
│  2. Call agent.streamEvents()                                    │
│  3. Display tool calls as they happen                            │
│  4. Show final answer                                            │
└─────────────────────────┬───────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────────┐
│                         AGENT                                    │
│               (src/agent/investigator.ts)                        │
│                                                                  │
│  createReactAgent combines:                                      │
│  - ChatAnthropic (talks to Claude)                               │
│  - Tools array (what the agent can do)                           │
│  - System prompt (how to behave)                                 │
└─────────────────────────┬───────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────────┐
│                         TOOLS                                    │
│                (src/tools/kubectl-get.ts)                        │
│                                                                  │
│  Each tool:                                                      │
│  - Has a name the agent uses to call it                          │
│  - Has a description telling the agent when to use it            │
│  - Has a schema defining what parameters it accepts              │
│  - Executes kubectl and returns the output                       │
└─────────────────────────────────────────────────────────────────┘
```

---

## What's Next

M2 gives us an agent that can investigate using `kubectl_get`. It can list resources and reason about what it sees.

M3 adds `kubectl_describe` - the agent will be able to get detailed information about specific resources. The tool descriptions will guide it: use get to find resources, describe to understand them.

M4 adds `kubectl_logs` - for debugging application-level issues. The agent will learn when cluster events aren't enough and it needs to see what the application itself is saying.
