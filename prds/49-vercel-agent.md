# PRD #49: Vercel AI SDK Agent Implementation

**Status**: Not Started
**Priority**: High
**Dependencies**: PRD #48 (cluster-whisperer modifications — shared tool core, --agent flag)
**Execution Order**: 5 of 5 — Last. Depends on PRD #48's tool core and --agent flag. M1 (research) can start during PRD #48 implementation.
**Branch**: `feature/prd-49-vercel-agent`

## Problem

The "Choose Your Own Adventure" demo's first audience vote is between agent frameworks:
LangGraph or Vercel AI SDK. The existing agent is built with LangGraph. A second agent
implementation using the Vercel AI SDK is needed so both options work during the demo.

Both agents must produce equivalent investigation experiences — the same tools, same
investigation quality, same reasoning visibility, same trace structure. The framework is
an implementation detail; the pattern is the point.

## Solution

Build a Vercel AI SDK agent that:
- Shares the existing tool core (`src/tools/core/`) via a new `src/tools/vercel/` wrapper layer
- Uses Claude as the LLM (same model as the LangGraph agent)
- Loads the same system prompt (`prompts/investigator.md`)
- Streams reasoning and tool calls to the CLI via a shared `AgentEvent` interface (same visible thinking experience)
- Has OTel instrumentation producing spans with identical names and attributes as the LangGraph agent
- Plugs into the `--agent vercel` CLI flag (plumbed in PRD #48 M4)
- Supports conversation memory via `--thread` (same multi-turn capability as LangGraph)

## Success Criteria

- `cluster-whisperer --agent vercel --tools kubectl "Why is my app broken?"` produces an investigation equivalent to the LangGraph agent
- The Vercel agent uses the same tool core functions as the LangGraph agent
- CLI output shows visible reasoning (thinking, tool calls, observations) in the same format — the audience should not be able to tell which agent is running
- OTel traces appear in Jaeger/Datadog with spans for LLM calls and tool executions
- Trace span names and attribute names are identical between both agents for shared span types (defined in `telemetry/registry/attributes.yaml`)
- The agent handles the full demo flow: investigate → discover missing DB → semantic search → deploy
- Existing LangGraph tests and behavior are unaffected
- Conversation memory (`--thread` flag) works with the Vercel agent — same multi-turn capability as LangGraph (PRD #48 M13 establishes the pattern)
- Both agents produce equivalently readable investigation stories in Datadog LLM Observability

## Non-Goals

- MCP tool wrapper for the Vercel agent (demo uses CLI only)
- Production deployment of the Vercel agent
- Performance optimization or benchmarking between agents
- Feature parity with LangGraph capabilities that don't affect the demo experience (e.g., LangGraph-specific checkpointer internals)

## Milestones

### M1: Research Phase
- [x] Use `/research` to investigate AI SDK's current agent API (may be called `ToolLoopAgent`, `generateText` with `maxSteps`, or something else — the SDK moves fast)
- [x] Use `/research` to investigate AI SDK's Anthropic provider — how to configure Claude, whether extended thinking / interleaved thinking is supported, model parameters
- [x] Verify: can AI SDK stream intermediate reasoning and tool calls to stdout? What does the streaming event model look like? Document the specific event types and their payloads — this is needed to implement the `AgentEvent` adapter in M5
- [x] Verify: does `experimental_telemetry` create spans compatible with our OTLP exporter setup? What span names does it produce? What `gen_ai.*` attributes does it set? Compare against the Weaver schema `telemetry/registry/attributes.yaml`
- [x] Verify: does AI SDK support extended thinking with `anthropic-beta: interleaved-thinking-2025-05-14`? This is critical — the LangGraph agent uses interleaved thinking and it produces the visible "Thinking:" blocks in the CLI. If the Vercel SDK doesn't support it, the CLI output will look fundamentally different and we need a fallback strategy
- [x] Research: how does AI SDK handle conversation history? LangGraph uses a `MemorySaver` checkpointer. The Vercel agent will need to manage message history manually — what message format does the SDK expect for multi-turn conversations?
- [x] Document findings and any gotchas in a research summary
- [x] Decision: confirm or adjust the implementation approach based on findings. Update the Technical Design section of this PRD if M1 reveals API changes

**Verification**: Research summary document exists with clear answers to each question above. If any answer is "not supported," the PRD has been updated with an alternative approach before proceeding to M2.

### M2: Weaver Schema Update
- [ ] Review M1 findings: what span names and attributes does the Vercel AI SDK's `experimental_telemetry` actually produce?
- [ ] Compare against existing attribute groups in `telemetry/registry/attributes.yaml`: root, tool, llm, mcp, subprocess, openllmetry, vectorstore, embedding, pipeline, http
- [ ] If the Vercel SDK produces different LLM span names than OpenLLMetry (e.g., `ai.generateText` instead of `anthropic.chat`): add a new attribute group `registry.cluster_whisperer.vercel_llm` documenting the Vercel SDK's LLM span attributes
- [ ] If the Vercel SDK uses different attribute names for token usage or model info: document the mapping so both agents' traces are understandable in Datadog
- [ ] Goal: after this milestone, every span name and attribute that will appear in traces from either agent is defined in the Weaver schema
- [ ] Run `npm run telemetry:check` — must pass
- [ ] Run `npm run telemetry:resolve` — must pass, regenerate `resolved.json`

**Verification**: `npm run telemetry:check` and `npm run telemetry:resolve` both pass. The schema diff shows new attribute groups covering Vercel SDK span names and attributes identified in M1.

### M3: Shared Agent Interface
- [ ] Define `AgentEvent` union type in `src/agent/agent-events.ts`:
  ```typescript
  type AgentEvent =
    | { type: "thinking"; content: string }
    | { type: "tool_start"; name: string; args: Record<string, unknown> }
    | { type: "tool_result"; content: string }
    | { type: "final_answer"; content: string };
  ```
- [ ] Define `InvestigationAgent` interface in `src/agent/agent-interface.ts`:
  ```typescript
  interface InvestigationAgent {
    investigate(
      question: string,
      options?: { threadId?: string; recursionLimit?: number }
    ): AsyncIterable<AgentEvent>;
  }
  ```
- [ ] Create `LangGraphAdapter` in `src/agent/langgraph-adapter.ts` — wraps the existing LangGraph agent's `streamEvents()` output and translates `on_chain_stream` chunks into `AgentEvent` objects. The translation logic (extracted from the current `src/index.ts` event processing loop):
  - `chunk.agent.messages` with `block.type === "thinking"` → `{ type: "thinking", content: block.thinking }`
  - `chunk.agent.messages` with `msg.tool_calls` → `{ type: "tool_start", name: tc.name, args: tc.args }` for each tool call
  - `chunk.agent.messages` without `tool_calls`, with `block.type === "text"` → `{ type: "final_answer", content: block.text }`
  - `chunk.tools.messages` → `{ type: "tool_result", content: msg.content }`
- [ ] The `LangGraphAdapter.investigate()` method handles conversation memory internally: calls `loadCheckpointer(threadId)` before the agent run, calls `saveCheckpointer()` after the agent run (same lifecycle currently in `src/index.ts`). This encapsulates the LangGraph-specific `MemorySaver` so the CLI doesn't touch it
- [ ] Update `CreateAgentOptions` in `src/agent/agent-factory.ts` — remove the `checkpointer: MemorySaver` field (that's a LangGraph-specific type). Thread ID is passed to `investigate()` instead
- [ ] Update `createAgent()` to return `InvestigationAgent` instead of the raw LangGraph agent
- [ ] Refactor `src/index.ts` to consume `AgentEvent` objects from `agent.investigate()` instead of calling `.streamEvents()` directly. The rendering logic stays the same — only the event source changes:
  ```typescript
  for await (const event of agent.investigate(question, { threadId })) {
    switch (event.type) {
      case "thinking":
        console.log(`\x1b[3mThinking: ${event.content}\x1b[0m\n`);
        break;
      case "tool_start":
        console.log(`🔧 Tool: ${event.name}`);
        console.log(`   Args: ${JSON.stringify(event.args)}`);
        break;
      case "tool_result":
        console.log(`   Result:\n${truncate(event.content, 1100)}`);
        console.log();
        break;
      case "final_answer":
        setTraceOutput(event.content);
        console.log("─".repeat(60));
        console.log("Answer:");
        console.log(event.content);
        console.log();
        break;
    }
  }
  ```
- [ ] Remove the `saveCheckpointer()` call from `src/index.ts` — it's now inside `LangGraphAdapter.investigate()`
- [ ] Update `src/agent/agent-factory.test.ts` — this test currently:
  - Mocks `createReactAgent` returning `{ invoke, stream, streamEvents }` — the return type changes to `InvestigationAgent` with `.investigate()`
  - Asserts "vercel throws not implemented" — keep this for now (M5 replaces it)
  - Checks tool groups are passed through — this still applies but the mock shape changes
- [ ] Unit tests for `LangGraphAdapter`: mock the LangGraph agent's `streamEvents()`, verify it emits correct `AgentEvent` objects for each chunk type (thinking, tool_start, tool_result, final_answer)

**Verification**:
- [ ] `npm test` passes — all existing tests pass (with updated mocks in `agent-factory.test.ts`), plus new `LangGraphAdapter` unit tests
- [ ] `npm run build` succeeds with no TypeScript errors
- [ ] Manual test: run `cluster-whisperer --agent langgraph --tools kubectl "What pods are running?"` against a cluster and confirm CLI output is identical to before the refactor (thinking blocks in italic, 🔧 tool calls, truncated results, ─ separator, "Answer:" label)
- [ ] Manual test: run with `--thread test-refactor` twice — second run sees prior conversation context (proves memory save/load still works through the adapter)

### M4: Vercel Tool Wrappers
- [ ] Create `src/tools/vercel/index.ts` with Vercel AI SDK `tool()` wrappers for all 5 core tools:
  1. `kubectl_get` — wraps `kubectlGet` from `src/tools/core/kubectl-get.ts`
  2. `kubectl_describe` — wraps `kubectlDescribe` from `src/tools/core/kubectl-describe.ts`
  3. `kubectl_logs` — wraps `kubectlLogs` from `src/tools/core/kubectl-logs.ts`
  4. `vector_search` — wraps `vectorSearch` from `src/tools/core/vector-search.ts`
  5. `kubectl_apply` — wraps `kubectlApply` from `src/tools/core/kubectl-apply.ts`
- [ ] Each wrapper: Zod input schema (from core), description string (from core), execute function calling core logic
- [ ] Kubeconfig factory pattern: create `createKubectlTools(options?: KubectlOptions)` mirroring `src/tools/langchain/index.ts` — kubectl tools capture kubeconfig path via closure at creation time
- [ ] Vector tool factory: create `createVectorTools(vectorStore: VectorStore)` mirroring `src/tools/langchain/index.ts` — vector and apply tools share a VectorStore instance with lazy initialization
- [ ] Apply tool factory: create `createApplyTools(vectorStore: VectorStore, kubectlOptions?: KubectlOptions)` mirroring the LangChain apply tool pattern — the apply tool needs both a VectorStore (for catalog validation) and optional kubeconfig
- [ ] Each tool's execute function must be wrapped with `withToolTracing()` from `src/tracing/tool-tracing.ts` — same as the LangChain wrappers. This ensures tool spans have identical names and attributes regardless of which agent framework calls them
- [ ] Unit tests for each wrapper: verify tool name, description, and that execute calls the core function with correct arguments

**Verification**:
- [ ] `npm test` passes — new unit tests for all 5 Vercel tool wrappers pass
- [ ] `npm run build` succeeds
- [ ] Each wrapper test verifies: tool has correct `name` string, correct `description` string (matches core export), and `execute()` delegates to the core function with the input parameters

### M5: Vercel Agent Implementation
- [ ] Create `src/agent/vercel-agent.ts` implementing the `InvestigationAgent` interface
- [ ] Same system prompt as LangGraph agent — loaded from `prompts/investigator.md` using the same path pattern (`path.join(__dirname, "../../prompts/investigator.md")`)
- [ ] Same Claude model: `claude-sonnet-4-20250514` (use the `ANTHROPIC_MODEL` constant exported from `src/agent/investigator.ts`, or define a shared constant)
- [ ] If M1 confirms interleaved thinking support: enable it with budget_tokens 4000 and `anthropic-beta: interleaved-thinking-2025-05-14` header
- [ ] If M1 shows no interleaved thinking support: document the limitation. The CLI will still work but "Thinking:" blocks won't appear, which the audience may notice. Add a note to M8 to document this difference
- [ ] `investigate()` method returns `AsyncIterable<AgentEvent>` by iterating over the Vercel SDK's streaming response and translating events (the specific translation depends on M1 research into the streaming event model)
- [ ] `maxSteps` set to 50 to match `RECURSION_LIMIT` from `src/agent/investigator.ts`
- [ ] Tool-set filtering: the factory passes the filtered Vercel tool array (from M4's factories), same as LangGraph receives filtered LangChain tools
- [ ] Agent factory integration: update the `case "vercel"` branch in `src/agent/agent-factory.ts` to construct and return the Vercel agent (replacing the "not yet implemented" error)

**Verification**:
- [ ] `npm test` passes — unit tests for the Vercel agent mock the AI SDK, verify it calls the streaming API with correct parameters: model, system prompt, tools, maxSteps
- [ ] `npm run build` succeeds
- [ ] `agent-factory.test.ts` updated: the "vercel" case now returns a valid `InvestigationAgent` instead of throwing
- [ ] Manual test against a real cluster: `CLUSTER_WHISPERER_AGENT=vercel CLUSTER_WHISPERER_TOOLS=kubectl vals exec -i -f .vals.yaml -- node dist/index.js "What pods are running?"` completes successfully, shows tool calls and a final answer
- [ ] If extended thinking is supported: verify "Thinking:" blocks appear in italic in CLI output

### M6: Conversation Memory
- [ ] Implement message history persistence for the Vercel agent's `--thread` flag
- [ ] The Vercel AI SDK does not have LangGraph's `MemorySaver` checkpointer. Implement a conversation history store:
  - After each `investigate()` call, serialize the full message array (system, user, assistant, tool_call, tool_result messages) to a JSON file
  - File location: `data/threads/` directory (same as the LangGraph checkpointer files from `src/agent/file-checkpointer.ts`)
  - File naming: `vercel-<threadId>.json` (prefixed to avoid collision with LangGraph thread files which are named `<threadId>.json`)
  - On resume with the same thread ID, load prior messages and prepend to the new Vercel SDK call
- [ ] The `investigate()` method in `vercel-agent.ts` handles load/save internally — the CLI just passes `threadId` through `options` (same pattern as `LangGraphAdapter`)
- [ ] Handle edge cases: missing file (start fresh), corrupt JSON (start fresh — same pattern as `file-checkpointer.ts`), different thread IDs are independent

**Verification**:
- [ ] Unit tests: round-trip save/load of conversation history (mirror the test patterns in `src/agent/file-checkpointer.test.ts`: fresh start, round-trip, directory creation, ID sanitization, corrupt file recovery, independent threads)
- [ ] `npm test` passes with new unit tests
- [ ] Manual test — run the Act 3a multi-turn conversation with the Vercel agent:
  ```bash
  export CLUSTER_WHISPERER_AGENT=vercel
  export CLUSTER_WHISPERER_TOOLS=kubectl,vector
  export CLUSTER_WHISPERER_THREAD=demo-vercel
  cluster-whisperer "What database should I deploy for my app?"
  # Agent finds multiple results, asks follow-up
  cluster-whisperer "I'm not sure. My team is the You Choose team."
  # Agent narrows to platform.acme.io
  cluster-whisperer "Yes please, will you deploy it for me?"
  # Agent says it can't — no apply tool
  ```
- [ ] Verify: the second and third invocations reference information from prior turns
- [ ] Verify: `data/threads/vercel-demo-vercel.json` file exists after the conversation
- [ ] Verify: deleting the thread file and re-running starts a fresh conversation

### M7: OTel Instrumentation
- [ ] Enable `experimental_telemetry: { isEnabled: true }` on all AI SDK calls in `vercel-agent.ts`
- [ ] The root investigation span is already provided by `withAgentTracing()` wrapping the `agent.investigate()` loop in `src/index.ts` (from M3 refactor). No additional work needed for the root span — it's framework-agnostic
- [ ] Tool execution spans are already provided by `withToolTracing()` wrapping each Vercel tool's execute function (from M4). No additional work needed for tool spans
- [ ] `setTraceOutput()` is already called when the `final_answer` event is received in the CLI rendering loop (from M3 refactor). No additional work needed for output recording
- [ ] Verify: the Vercel SDK's `experimental_telemetry` spans nest correctly under our root span (their parent IDs chain back to the root `cluster-whisperer.cli.investigate` span). If they don't (same AsyncLocalStorage context loss that LangGraph had — see OpenLLMetry-JS Issue #476 and `src/tracing/context-bridge.ts`), apply the `withStoredContext()` bridge

**Verification procedure — console exporter** (run this first):
```bash
npm run build

OTEL_TRACING_ENABLED=true \
OTEL_EXPORTER_TYPE=console \
OTEL_CAPTURE_AI_PAYLOADS=true \
CLUSTER_WHISPERER_AGENT=vercel \
CLUSTER_WHISPERER_TOOLS=kubectl \
vals exec -i -f .vals.yaml -- node dist/index.js "What pods are running?"
```

- [ ] Console output shows root span: name `cluster-whisperer.cli.investigate`, attribute `cluster_whisperer.invocation.mode: cli`
- [ ] Console output shows tool spans (e.g., `kubectl_get.tool`) with `parentId` pointing to root span's `spanId`
- [ ] Console output shows Vercel SDK LLM spans (span name from M1 research) with `gen_ai.request.model` attribute
- [ ] All spans share the same `traceId` (single trace, not fragmented)
- [ ] Root span has `gen_ai.input.messages` attribute (requires `OTEL_CAPTURE_AI_PAYLOADS=true`)
- [ ] After investigation completes, root span has `gen_ai.output.messages` attribute containing the final answer text

**Verification procedure — OTLP to Datadog** (run after console verification passes):
```bash
OTEL_TRACING_ENABLED=true \
OTEL_EXPORTER_TYPE=otlp \
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 \
OTEL_CAPTURE_AI_PAYLOADS=true \
CLUSTER_WHISPERER_AGENT=vercel \
CLUSTER_WHISPERER_TOOLS=kubectl \
vals exec -i -f .vals.yaml -- node dist/index.js "Find the broken pod and tell me why it's failing"
```

- [ ] Trace appears in Datadog APM: search `service:cluster-whisperer`
- [ ] Trace flame graph shows the expected span hierarchy (root → LLM calls → tool calls → subprocess)
- [ ] Trace appears in Datadog LLM Observability with CONTENT column showing clean INPUT and OUTPUT text (not raw JSON, not "No content")
- [ ] Token usage is populated in the Datadog LLM Observability view

**Target span hierarchy** (confirmed from AI SDK telemetry docs):
```text
cluster-whisperer.cli.investigate          (root, withAgentTracing)
├── ai.streamText                          (Vercel SDK outer span)
│   └── ai.streamText.doStream             (LLM API call, has gen_ai.* attrs)
├── kubectl_get.tool                       (withToolTracing)
│   └── kubectl get pods                   (subprocess span)
├── ai.streamText                          (next step)
│   └── ai.streamText.doStream
├── kubectl_describe.tool
│   └── kubectl describe pod demo-app-xxx
└── ai.streamText                          (final step)
    └── ai.streamText.doStream
```

### M8: Equivalence Testing
- [ ] Run both agents against the same demo scenario using the exact commands from `docs/choose-your-adventure-demo.md`

**Test 1: Act 2 — single-turn investigation** (run with each agent, compare output):
```bash
# LangGraph
export CLUSTER_WHISPERER_AGENT=langgraph
export CLUSTER_WHISPERER_TOOLS=kubectl
cluster-whisperer "Something's wrong with my application — can you investigate what's happening and why?"

# Vercel
export CLUSTER_WHISPERER_AGENT=vercel
export CLUSTER_WHISPERER_TOOLS=kubectl
cluster-whisperer "Something's wrong with my application — can you investigate what's happening and why?"
```

- [ ] Both agents produce CLI output in this format (identical structure, content may vary):
  ```text
  Question: Something's wrong with my application — can you investigate?

  Thinking: [italic text — agent's reasoning]

  🔧 Tool: kubectl_get
     Args: {"resource":"pods","namespace":"all"}
     Result:
  [truncated kubectl output, max 1100 chars]

  Thinking: [italic text — next reasoning step]

  🔧 Tool: [next tool call]
     Args: [...]
     Result:
  [...]

  ────────────────────────────────────────────────────────────
  Answer:
  [agent's conclusion about the broken app]
  ```
- [ ] Both agents identify CrashLoopBackOff and investigate with describe/logs
- [ ] Both agents reach a conclusion about the missing database

**Test 2: Act 2 — CRD wall** (demonstrates the agent hitting limits without vector search):
```bash
cluster-whisperer "Do you know what database I should use?"
```
- [ ] Both agents attempt `kubectl get crd` and struggle with the volume of CRDs

**Test 3: Act 3a — multi-turn conversation with vector search**:
```bash
export CLUSTER_WHISPERER_TOOLS=kubectl,vector
export CLUSTER_WHISPERER_THREAD=demo-equiv-test
cluster-whisperer "What database should I deploy for my app?"
cluster-whisperer "I'm not sure. My team is the You Choose team. I don't know if it's Postgres or MySQL."
cluster-whisperer "Yes please, will you deploy it for me?"
```
- [ ] Agent finds multiple ManagedService results, asks follow-up questions
- [ ] Agent narrows to `platform.acme.io` based on team name
- [ ] Agent says it can't deploy (no apply tool)
- [ ] Conversation memory works across all three invocations

**Test 4: Act 3b — deploy**:
```bash
export CLUSTER_WHISPERER_TOOLS=kubectl,vector,apply
cluster-whisperer "Go ahead and deploy it"
```
- [ ] Agent deploys the ManagedService using kubectl_apply
- [ ] The catalog validation works (only approved resource types can be deployed)

**Test 5: Trace comparison**:
- [ ] Run Test 1 with both agents with `OTEL_TRACING_ENABLED=true OTEL_EXPORTER_TYPE=otlp`
- [ ] Open both traces in Datadog
- [ ] Root spans have identical names (`cluster-whisperer.cli.investigate`) and identical `cluster_whisperer.*` attributes
- [ ] Tool spans have identical names (`kubectl_get.tool`, etc.) and attributes
- [ ] LLM span names differ (expected: `anthropic.chat` vs `ai.streamText.doStream`) — this is documented in the Weaver schema (M2)
- [ ] Both traces tell a readable investigation story in the Datadog flame graph

**Test 6: Save demo runs**:
- [ ] Save full agent output from both agents to `demo/runs/` for comparison (same pattern as PRD #48 M11)
- [ ] File names: `<timestamp>-vercel-act2.txt`, `<timestamp>-langgraph-act2.txt`, etc.

### M9: Documentation
- [ ] Update README using `/write-docs` to document the Vercel agent and `--agent` flag
- [ ] Update `docs/choose-your-adventure-demo.md` if any demo flow adjustments are needed
- [ ] Update `docs/tracing-conventions.md` with Vercel-specific notes (different LLM span names, how experimental_telemetry integrates with our root span)
- [ ] If M1 reveals any Vercel SDK limitations not caught in pre-research: document them prominently

**Verification**: All documentation changes reviewed. `docs/choose-your-adventure-demo.md` is accurate for both agent options. A new reader could understand `--agent vercel` and any behavioral differences from reading the docs alone.

## Pre-Research Findings (2026-03-16)

Research conducted before implementation to de-risk M1. These findings inform the
technical design but M1 should still verify hands-on. AI SDK APIs change frequently.

### AI SDK Version

AI SDK 6 is current. The `ToolLoopAgent` class is the recommended approach for agents.
It wraps `streamText`/`generateText` with a `.stream()` and `.generate()` interface,
default 20 steps, configurable via `stopWhen: stepCountIs(N)`.

### Extended Thinking: Fully Supported

The Vercel AI SDK Anthropic provider supports both extended thinking and interleaved
thinking. Configuration:

```typescript
providerOptions: {
  anthropic: {
    thinking: { type: 'enabled', budgetTokens: 4000 },
    headers: { 'anthropic-beta': 'interleaved-thinking-2025-05-14' },
  },
},
```

Thinking text is accessible via `result.reasoningText` and streaming reasoning parts.
This means "Thinking:" blocks will appear in CLI output for both agents — the biggest
risk is eliminated.

### Tool Definition API

AI SDK 6 uses `inputSchema` (not `parameters`):

```typescript
const myTool = tool({
  description: 'Tool description',
  inputSchema: z.object({ ... }),  // NOT parameters
  execute: async (params) => { ... },
});
```

### Telemetry Span Names

The AI SDK's `experimental_telemetry` produces these span types for `streamText`:

| Span Name | Type | Key Attributes |
|-----------|------|---------------|
| `ai.streamText` | Outer span (full call) | `ai.model.id`, `ai.usage.*`, `ai.response.text` |
| `ai.streamText.doStream` | Inner LLM call | `gen_ai.system`, `gen_ai.request.model`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, `ai.prompt.messages`, `ai.prompt.tools` |
| `ai.toolCall` | Tool execution | `ai.toolCall.name`, `ai.toolCall.args`, `ai.toolCall.result` |

Key: the inner `doStream` span carries `gen_ai.*` semconv attributes, which is what
Datadog LLM Observability recognizes. This means token usage dashboards should work.

The SDK also supports a custom `tracer` parameter in `experimental_telemetry`, allowing
us to pass our existing TracerProvider for proper context propagation.

### Conversation Memory

The SDK accepts a `messages` array for multi-turn conversations. No built-in
persistence — we serialize/deserialize the message history ourselves (M6).

### Setup Script

`demo/cluster/setup.sh` deploys cluster infrastructure (GKE, Crossplane, vector DBs,
observability backends, demo app). It does not reference agent frameworks. The `--agent`
flag is an env var set at demo time by the presenter. **No setup.sh changes needed.**

### Cluster Requirements by Milestone

| Milestone | Cluster Needed? | Why |
|-----------|----------------|-----|
| M1: Research | No | API investigation, no execution |
| M2: Weaver Schema | No | Schema editing and validation |
| M3: Shared Interface | No for tests, yes for manual verify | Unit tests mock the agent; manual run needs kubectl |
| M4: Tool Wrappers | No | Unit tests only |
| M5: Vercel Agent | Yes | Manual verification against real cluster |
| M6: Conversation Memory | Yes | Multi-turn demo flow needs cluster + vector DBs |
| M7: OTel | Yes | Needs cluster + Datadog Agent for trace verification |
| M8: Equivalence Testing | Yes | Full demo cluster with Crossplane, vector DBs, broken app |
| M9: Documentation | No | Docs only |

## Technical Design

### Tool Wrapper Pattern

The existing three-layer architecture extends naturally:

```text
src/tools/core/kubectl-get.ts      ← Shared logic (schema, execute, description)
src/tools/langchain/index.ts       ← LangGraph wrappers (existing)
src/tools/vercel/index.ts          ← Vercel AI SDK wrappers (new)
```

Vercel tool definition (AI SDK 6 uses `inputSchema`, not `parameters`):
```typescript
import { tool } from 'ai';
import { kubectlGetSchema, kubectlGet, kubectlGetDescription } from '../core/kubectl-get';

export const kubectlGetTool = tool({
  description: kubectlGetDescription,
  inputSchema: kubectlGetSchema,  // Zod schema from core — AI SDK 6 uses inputSchema
  execute: async (params) => {
    const { output } = await kubectlGet(params);
    return output;
  },
});
```

### Shared Agent Interface

The `InvestigationAgent` interface follows the same pattern as the `VectorStore` interface
— the consumer (CLI) doesn't know which implementation is running:

```text
src/agent/agent-events.ts          ← AgentEvent union type
src/agent/agent-interface.ts       ← InvestigationAgent interface
src/agent/langgraph-adapter.ts     ← Wraps existing LangGraph agent
src/agent/vercel-agent.ts          ← New Vercel AI SDK agent
src/agent/agent-factory.ts         ← Returns InvestigationAgent (updated)
```

The CLI rendering code in `src/index.ts` becomes framework-agnostic:

```typescript
const agent = createAgent({ agentType, toolGroups, vectorBackend, kubeconfig });

await withAgentTracing(question, async () => {
  for await (const event of agent.investigate(question, { threadId })) {
    switch (event.type) {
      case "thinking":
        console.log(`\x1b[3mThinking: ${event.content}\x1b[0m\n`);
        break;
      case "tool_start":
        console.log(`🔧 Tool: ${event.name}`);
        console.log(`   Args: ${JSON.stringify(event.args)}`);
        break;
      case "tool_result":
        console.log(`   Result:\n${truncate(event.content, 1100)}`);
        console.log();
        break;
      case "final_answer":
        setTraceOutput(event.content);
        console.log("─".repeat(60));
        console.log("Answer:");
        console.log(event.content);
        console.log();
        break;
    }
  }
});
```

### Agent Implementation

M1 research confirmed `streamText` is the right choice over `ToolLoopAgent`. While
`ToolLoopAgent` is Vercel's recommended convenience wrapper, `streamText` provides direct
access to `fullStream` with fine-grained stream parts (`reasoning`, `tool-call`,
`tool-result`, `step-finish`) needed for the `AgentEvent` adapter. See
`docs/research/m1-vercel-ai-sdk-research.md` for the full rationale.

```typescript
import { streamText, stepCountIs } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';

const result = streamText({
  model: anthropic('claude-sonnet-4-20250514'),
  system: investigatorPrompt,
  prompt: question,
  tools: filteredTools,
  stopWhen: stepCountIs(50),
  providerOptions: {
    anthropic: {
      thinking: { type: 'enabled', budgetTokens: 4000 },
      headers: { 'anthropic-beta': 'interleaved-thinking-2025-05-14' },
    },
  },
  experimental_telemetry: {
    isEnabled: true,
    functionId: 'cluster-whisperer-investigate',
  },
});
```

### Streaming to CLI

The `streamText` result exposes a `fullStream` property — an `AsyncIterable<TextStreamPart>`
that emits all events during a multi-step agent run. The `AgentEvent` adapter iterates
over `fullStream` and translates part types:

- `'reasoning'` (with `textDelta`) → `AgentEvent.thinking`
- `'tool-call'` (with `toolName`, `args`) → `AgentEvent.tool_start`
- `'tool-result'` (with `toolName`, `result`) → `AgentEvent.tool_result`
- `'text-delta'` (with `textDelta`) → accumulate for `AgentEvent.final_answer`
- `'step-finish'` → detect final step (finishReason === 'stop') to emit final answer

The SDK also offers lifecycle callbacks (`onStepFinish`, `experimental_onToolCallStart`,
`experimental_onToolCallFinish`) as supplements, but the stream parts are sufficient.

For extended thinking, `fullStream` emits `reasoning` parts between tool calls when
interleaved thinking is enabled. `result.reasoningText` gives aggregated thinking after
the stream completes; for real-time CLI output, use the stream parts.

### OTel Integration

The Vercel AI SDK creates spans natively via `experimental_telemetry`:
- `ai.streamText` — outer span wrapping the full multi-step call
- `ai.streamText.doStream` — individual LLM API call (contains `gen_ai.*` semconv attributes including `gen_ai.system`, `gen_ai.request.model`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`)
- `ai.toolCall` — tool execution spans (contains `ai.toolCall.name`, `ai.toolCall.args`, `ai.toolCall.result`)

These are different span names than the LangGraph/OpenLLMetry stack (`anthropic.chat`,
`<toolName>.tool`). Both sets of names are documented in the Weaver schema (M2).

For span attributes and context propagation, both agents share:
- `withAgentTracing()` for the root span (identical span name and attributes)
- `withToolTracing()` for tool execution spans (identical span name and attributes)
- `setTraceOutput()` for recording the final answer on the root span
- The same OTLP exporter setup (`src/tracing/index.ts`)

The key difference: LangGraph uses OpenLLMetry (`@traceloop/node-server-sdk`) for LLM
call spans. The Vercel agent uses the SDK's built-in `experimental_telemetry`. Both
produce LLM spans with `gen_ai.*` attributes, but the span names differ.

### Conversation Memory

LangGraph uses a `MemorySaver` checkpointer (wrapped with file persistence in
`src/agent/file-checkpointer.ts`) that saves/restores full agent state between CLI
invocations. Files are stored in `data/threads/<threadId>.json`.

The Vercel agent manages conversation memory manually:
1. After each investigation, serialize the full message array to `data/threads/vercel-<threadId>.json`
2. On the next invocation with the same thread ID, deserialize and prepend to the new call
3. Handle corrupt/missing files gracefully (start fresh, same pattern as `file-checkpointer.ts`)

### Telemetry Contract

Both agents must produce traces with identical span names and attributes for all shared
span types. The Weaver schema (`telemetry/registry/attributes.yaml`) is the source of
truth.

**Identical between agents** (enforced by shared code):

| Span | Name | Created By |
|------|------|-----------|
| Root | `cluster-whisperer.cli.investigate` | `withAgentTracing()` in `src/tracing/context-bridge.ts` |
| Tool | `<toolName>.tool` | `withToolTracing()` in `src/tracing/tool-tracing.ts` |
| Subprocess | `kubectl <op> <resource>` | `executeKubectl()` in `src/utils/kubectl.ts` |

**Different between agents** (framework-native LLM spans):

| Agent | LLM Span Name | Source |
|-------|---------------|--------|
| LangGraph | `anthropic.chat` | OpenLLMetry auto-instrumentation |
| Vercel | `ai.streamText.doStream` | `experimental_telemetry` |

Both LLM span types should carry `gen_ai.*` attributes (model, token usage, etc.).
The M2 Weaver schema update documents both.

**CLI-mode trace levels** (3 levels, same for both agents):
1. Root investigation span (`cluster-whisperer.cli.investigate`)
2. LLM call spans (`anthropic.chat` or `ai.streamText.doStream`)
3. Tool + subprocess spans (`<tool>.tool` → `kubectl <op> <resource>`)

Note: The fourth trace level (Claude Code / MCP) only applies when the agent is invoked
via the MCP server (PRDs #15 and #16). MCP mode is out of scope for the Vercel agent.
The three CLI-mode levels provide full observability for the KubeCon demo.

## Key Files Reference

These existing files are directly relevant to implementation. Read before starting each milestone.

| File | Relevant To | Why |
|------|------------|-----|
| `src/index.ts` | M3, M7 | Current CLI event loop — the code being refactored to use AgentEvent |
| `src/agent/investigator.ts` | M5 | LangGraph agent config — model, thinking settings, RECURSION_LIMIT, system prompt loading |
| `src/agent/agent-factory.ts` | M3, M5 | Factory to update — currently returns raw LangGraph agent |
| `src/agent/agent-factory.test.ts` | M3, M5 | Tests to update — mocks and assertions change with new interface |
| `src/agent/file-checkpointer.ts` | M6 | Existing conversation memory pattern to mirror |
| `src/agent/file-checkpointer.test.ts` | M6 | Test patterns to mirror for Vercel memory tests |
| `src/tools/langchain/index.ts` | M4 | LangChain wrapper pattern to mirror for Vercel wrappers |
| `src/tools/core/index.ts` | M4 | All 5 core tool exports (kubectl_get, kubectl_describe, kubectl_logs, vector_search, kubectl_apply) |
| `src/tracing/context-bridge.ts` | M7 | `withAgentTracing()`, `setTraceOutput()`, `withStoredContext()`, AsyncLocalStorage bridge |
| `src/tracing/tool-tracing.ts` | M4, M7 | `withToolTracing()` wrapper for tool spans |
| `telemetry/registry/attributes.yaml` | M2 | Weaver schema — source of truth for span attributes |
| `docs/choose-your-adventure-demo.md` | M8 | Demo flow — the exact commands for equivalence testing |
| `prompts/investigator.md` | M5 | System prompt — shared between both agents |

## Decision Log

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-03-07 | Research phase first | AI SDK moves fast; API names may have changed. Verify against current docs before implementation. Use `/research` skill. |
| 2026-03-07 | Share tool core, not tool wrappers | Core logic is framework-agnostic. Each framework gets thin wrappers. |
| 2026-03-07 | CLI only, no MCP | Demo uses CLI for visible reasoning. MCP would hide the agent's thinking. |
| 2026-03-07 | Match CLI output format | Audience shouldn't notice which agent is running. The framework choice is an implementation detail. |
| 2026-03-16 | Shared `AgentEvent` interface | Same pattern as `VectorStore` — the CLI doesn't know which agent it's consuming. Enforces identical output by construction, not by manual comparison. Prevents the two code paths from drifting. |
| 2026-03-16 | Weaver schema update before implementation | Both agents' span names must be defined before code is written. The schema is the contract. |
| 2026-03-16 | Explicit conversation memory milestone | Vercel SDK has no built-in checkpointer. Manual message history management is non-trivial and must be a tracked deliverable, not an afterthought. |
| 2026-03-16 | Extended thinking is required if available | The LangGraph agent uses interleaved thinking. If the Vercel SDK supports it, use it. If not, document the limitation — the CLI output will differ and the audience may notice. |
| 2026-03-16 | Pre-research confirms extended thinking works | AI SDK Anthropic provider supports `thinking: { type: 'enabled', budgetTokens: 4000 }` with `anthropic-beta: interleaved-thinking-2025-05-14`. Biggest risk eliminated. |
| 2026-03-16 | Tool API uses `inputSchema` not `parameters` | AI SDK 6 changed the tool definition API. Core Zod schemas pass directly to `inputSchema`. |
| 2026-03-16 | `streamText` span names confirmed | `ai.streamText` (outer), `ai.streamText.doStream` (inner, has `gen_ai.*` attrs), `ai.toolCall`. Different from OpenLLMetry's `anthropic.chat`. |
| 2026-03-16 | Use `streamText` directly (not `ToolLoopAgent`) | M1 research confirmed `streamText` provides better access to `fullStream` with fine-grained stream parts (`reasoning`, `tool-call`, `tool-result`) needed for the AgentEvent adapter. `ToolLoopAgent` is a convenience wrapper that hides the low-level events. See `docs/research/m1-vercel-ai-sdk-research.md`. |
| 2026-03-16 | No setup.sh changes needed | Cluster infrastructure is agent-framework-agnostic. The Vercel agent is local code only. |
| 2026-03-16 | M1–M4 don't need a cluster | Spin up GCP cluster when starting M5. |
