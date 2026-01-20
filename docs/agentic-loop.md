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

Most of our code is plain TypeScript. LangChain provides three key pieces:

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

### 3. streamEvents()

A method on the agent that streams internal events as they happen. All LangChain/LangGraph runnables have this method - it's part of their common interface.

```typescript
// These methods come with the agent automatically - no extra import needed:
agent.invoke()        // Run and return final result
agent.stream()        // Stream output chunks
agent.streamEvents()  // Stream detailed internal events
```

There's no separate import for these methods. The object returned by `createReactAgent` already has them built in - like how a JavaScript array already has `.map()` and `.filter()` without importing anything extra.

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

The agent emits many events as it works. Here are the three we care about:

#### `on_tool_start`
**When**: The model has decided to call a tool and is about to execute it.

**What happened before**: The model received the question (or previous tool results), reasoned about what to do next, and output a "tool call" requesting a specific tool with specific arguments.

**What you get**:
- `event.name` - which tool (e.g., "kubectl_get")
- `event.data.input` - the arguments the model chose (e.g., `{resource: "pods", namespace: "default"}`)

#### `on_tool_end`
**When**: The tool finished executing and returned a result.

**What happened**: Our code ran the tool (e.g., executed `kubectl get pods`), and now the result is ready to send back to the model.

**What you get**:
- `event.data.output` - the tool's return value (e.g., the kubectl output string)

**What happens next**: The result gets added to the conversation, and the model will see it on its next turn to decide what to do.

#### `on_chat_model_end`
**When**: The model finished generating a response.

**What you get**:
- `event.data.output.content` - what the model said

**Important**: This fires multiple times during an investigation:
1. After the model decides to call a tool (content contains the tool call)
2. After the model sees tool results and decides to call another tool
3. After the model has enough info and generates the final answer

We capture the content each time, so by the end, `finalAnswer` holds the last thing the model said (the summary).

### Putting It Together

```
User asks question
    ↓
[on_chat_model_end] → model decides to call kubectl_get
    ↓
[on_tool_start] → kubectl_get is about to run
    ↓
[on_tool_end] → kubectl_get finished, here's the output
    ↓
[on_chat_model_end] → model sees output, decides it has enough info
    ↓
Final answer displayed
```

### Code Example

```typescript
const eventStream = investigatorAgent.streamEvents(
  { messages: [new HumanMessage(question)] },
  { version: "v2" }
);

for await (const event of eventStream) {
  if (event.event === "on_tool_start") {
    console.log(`Tool: ${event.name}`);
    console.log(`Args: ${JSON.stringify(event.data.input)}`);
  }

  if (event.event === "on_tool_end") {
    console.log(`Result: ${event.data.output.content}`);
  }

  if (event.event === "on_chat_model_end") {
    // Capture each time - the last one will be the final answer
    finalAnswer = event.data.output?.content;
  }
}
```

There are many other event types (on_chain_start, on_llm_stream, etc.) but these three show the essential flow.

---

## The System Prompt

### What Makes It a "System" Prompt?

When you send messages to an LLM, each message has a **role**:

| Role | Who it's from | Purpose |
|------|---------------|---------|
| `system` | The application developer (you) | Set the model's behavior, role, constraints |
| `user` | The end user | The actual question or request |
| `assistant` | The model | The model's response |

"System prompt" means instructions from the **system** (your application), not from the user. The user never sees or types it - it's injected behind the scenes.

```
[system] You are a Kubernetes investigator...  ← system prompt (from your app)
[user] What pods are running?                   ← user prompt (from the human)
[assistant] Let me check...                     ← model's response
```

**Tool descriptions** are different - they're metadata attached to each tool, not messages in the conversation. The model sees them as "here are the tools you can use" rather than as conversation history.

### Our System Prompt

Ours is minimal - about 10 lines:

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

### Where Is It Used in the Code?

The system prompt lives in `prompts/investigator.md` as a separate file. Here's how it gets to the agent:

**Step 1: Load the file** (in `src/agent/investigator.ts`)
```typescript
const promptPath = path.join(__dirname, "../../prompts/investigator.md");
const systemPrompt = fs.readFileSync(promptPath, "utf8");
```

**Step 2: Pass it to createReactAgent via the `stateModifier` option**
```typescript
export const investigatorAgent = createReactAgent({
  llm: model,                    // which model to use
  tools: [kubectlGetTool],       // which tools the agent can call
  stateModifier: systemPrompt,   // what to prepend to conversations
});
```

Note: `stateModifier` isn't something you import - it's just a configuration option that `createReactAgent` accepts. Like how you don't import `timeout` when you write `{ timeout: 5000 }`.

**What the `stateModifier` option does**: It tells `createReactAgent` to prepend the system prompt to every conversation. When the user asks "What pods are running?", the model actually receives:

```
[System] You are a Kubernetes cluster investigator...
[User] What pods are running?
```

The user never sees or types the system prompt - it's automatically injected by `createReactAgent` before every request.

**Why a separate file?** It's easier to iterate on the prompt wording without touching code. You can tweak the tone, add examples, or adjust instructions without recompiling TypeScript.

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

