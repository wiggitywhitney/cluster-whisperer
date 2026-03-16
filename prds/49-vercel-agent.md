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
- [x] Add new attribute group `registry.cluster_whisperer.vercel_llm` to `telemetry/registry/attributes.yaml` with the Vercel SDK's LLM span attributes (M1 confirmed these differ from OpenLLMetry):
  - Outer span name: `ai.streamText` — attributes: `ai.model.id`, `ai.model.provider`, `ai.usage.promptTokens`, `ai.usage.completionTokens`, `ai.telemetry.functionId`, `ai.telemetry.metadata.*`
  - Inner span name: `ai.streamText.doStream` — attributes: `gen_ai.system`, `gen_ai.request.model`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, `gen_ai.response.model`, `gen_ai.response.id`, `gen_ai.response.finish_reasons`, `ai.prompt.messages`, `ai.prompt.tools`, `ai.response.msToFirstChunk`, `ai.response.msToFinish`
  - Note: `gen_ai.*` semconv attributes are ONLY on the inner `doStream` spans (not the outer `ai.streamText` span). This is what Datadog LLM Observability reads for token usage.
- [x] Add new attribute group `registry.cluster_whisperer.vercel_tool` for the SDK's own tool spans:
  - Span name: `ai.toolCall` — attributes: `ai.toolCall.name`, `ai.toolCall.id`, `ai.toolCall.args`, `ai.toolCall.result`
  - Note: These are in ADDITION to our `withToolTracing()` spans (`<toolName>.tool`). Both will appear in traces. Document the relationship: `ai.toolCall` is the SDK-generated span; `<toolName>.tool` is our custom span with `cluster_whisperer.*` attributes.
- [x] Add span events to the schema: `ai.stream.firstChunk` and `ai.stream.finish` (events on `doStream` spans, not separate spans)
- [x] Document the mapping between OpenLLMetry (LangGraph) and Vercel SDK span names so both agents' traces are understandable in Datadog:
  - LangGraph LLM calls: `anthropic.chat` (OpenLLMetry) → Vercel LLM calls: `ai.streamText.doStream` (SDK telemetry)
  - Both carry `gen_ai.*` attributes with the same semantic conventions
- [x] Run `npm run telemetry:check` — must pass
- [x] Run `npm run telemetry:resolve` — must pass, regenerate `resolved.json`

**Verification**: `npm run telemetry:check` and `npm run telemetry:resolve` both pass. `git diff telemetry/registry/attributes.yaml` shows new attribute groups for `vercel_llm` and `vercel_tool` covering all Vercel SDK span names and attributes.

### M3: Shared Agent Interface
- [x] Define `AgentEvent` union type in `src/agent/agent-events.ts`:
  ```typescript
  type AgentEvent =
    | { type: "thinking"; content: string }
    | { type: "tool_start"; toolName: string; args: Record<string, unknown> }
    | { type: "tool_result"; toolName: string; result: string }
    | { type: "final_answer"; content: string };
  ```
- [x] Define `InvestigationAgent` interface in `src/agent/agent-interface.ts`:
  ```typescript
  interface InvestigationAgent {
    investigate(
      question: string,
      options?: { threadId?: string }
    ): AsyncGenerator<AgentEvent>;
  }
  ```
- [x] Create `LangGraphAdapter` in `src/agent/langgraph-adapter.ts` — wraps the existing LangGraph agent's `streamEvents()` output and translates `on_chain_stream` chunks into `AgentEvent` objects. The translation logic (extracted from the current `src/index.ts` event processing loop):
  - `chunk.agent.messages` with `block.type === "thinking"` → `{ type: "thinking", content: block.thinking }`
  - `chunk.agent.messages` with `msg.tool_calls` → `{ type: "tool_start", toolName: tc.name, args: tc.args }` for each tool call
  - `chunk.agent.messages` without `tool_calls`, with `block.type === "text"` → `{ type: "final_answer", content: block.text }`
  - `chunk.tools.messages` → `{ type: "tool_result", toolName: msg.name, result: msg.content }`
- [x] The `LangGraphAdapter.investigate()` method handles conversation memory internally: calls `loadCheckpointer(threadId)` before the agent run, calls `saveCheckpointer()` after the agent run (same lifecycle currently in `src/index.ts`). This encapsulates the LangGraph-specific `MemorySaver` so the CLI doesn't touch it
- [x] Update `CreateAgentOptions` in `src/agent/agent-factory.ts` — remove the `checkpointer: MemorySaver` field (that's a LangGraph-specific type). Thread ID is passed to `investigate()` instead
- [x] Update `createAgent()` to return `InvestigationAgent` instead of the raw LangGraph agent
- [x] Refactor `src/index.ts` to consume `AgentEvent` objects from `agent.investigate()` instead of calling `.streamEvents()` directly. The rendering logic stays the same — only the event source changes:
  ```typescript
  for await (const event of agent.investigate(question, { threadId }) as AsyncGenerator<AgentEvent>) {
    switch (event.type) {
      case "thinking":
        console.log(`\x1b[3mThinking: ${event.content}\x1b[0m\n`);
        break;
      case "tool_start":
        console.log(`🔧 Tool: ${event.toolName}`);
        console.log(`   Args: ${JSON.stringify(event.args)}`);
        break;
      case "tool_result":
        console.log(`   Result:\n${truncate(event.result, 1100)}`);
        console.log();
        break;
      case "final_answer":
        finalAnswer = event.content;
        break;
    }
  }
  ```
- [x] Remove the `saveCheckpointer()` call from `src/index.ts` — it's now inside `LangGraphAdapter.investigate()`
- [x] Update `src/agent/agent-factory.test.ts` — this test currently:
  - Mocks `createReactAgent` returning `{ invoke, stream, streamEvents }` — the return type changes to `InvestigationAgent` with `.investigate()`
  - Asserts "vercel throws not implemented" — keep this for now (M5 replaces it)
  - Checks tool groups are passed through — this still applies but the mock shape changes
- [x] Unit tests for `LangGraphAdapter`: mock the LangGraph agent's `streamEvents()`, verify it emits correct `AgentEvent` objects for each chunk type (thinking, tool_start, tool_result, final_answer)

**Verification**:
- [x] `npm test` passes — all existing tests pass (with updated mocks in `agent-factory.test.ts`), plus new `LangGraphAdapter` unit tests
- [x] `npm run build` succeeds with no TypeScript errors
- [x] Manual test: run `cluster-whisperer --agent langgraph --tools kubectl "What pods are running?"` against a cluster and confirm CLI output is identical to before the refactor (thinking blocks in italic, 🔧 tool calls, truncated results, ─ separator, "Answer:" label)
- [x] Manual test: run with `--thread test-refactor` twice — second run sees prior conversation context (proves memory save/load still works through the adapter)

### M4: Vercel Tool Wrappers
- [x] Create `src/tools/vercel/index.ts` with AI SDK 6 `tool()` wrappers (import from `'ai'`, NOT `@langchain/core/tools`). The `tools` parameter in `streamText` is `Record<string, Tool>` — tool names are the object keys:
  ```typescript
  import { tool } from 'ai';
  import { kubectlGetSchema, kubectlGet, kubectlGetDescription } from '../core/kubectl-get';
  import { withToolTracing } from '../../tracing/tool-tracing';

  // SDK 6 uses inputSchema (not parameters or schema)
  const kubectl_get = tool({
    description: kubectlGetDescription,
    inputSchema: kubectlGetSchema,  // Zod schema from core
    execute: withToolTracing(
      { name: 'kubectl_get', description: kubectlGetDescription },
      async (input) => {
        const { output } = await kubectlGet(input, options);
        return output;
      }
    ),
  });
  ```
- [x] Wrap all 5 core tools:
  1. `kubectl_get` — wraps `kubectlGet` from `src/tools/core/kubectl-get.ts`
  2. `kubectl_describe` — wraps `kubectlDescribe` from `src/tools/core/kubectl-describe.ts`
  3. `kubectl_logs` — wraps `kubectlLogs` from `src/tools/core/kubectl-logs.ts`
  4. `vector_search` — wraps `vectorSearch` from `src/tools/core/vector-search.ts`
  5. `kubectl_apply` — wraps `kubectlApply` from `src/tools/core/kubectl-apply.ts`
- [x] Kubeconfig factory: `createKubectlTools(options?: KubectlOptions)` returning `Record<string, Tool>` — mirrors `src/tools/langchain/index.ts` pattern, captures kubeconfig via closure
- [x] Vector tool factory: `createVectorTools(vectorStore: VectorStore)` returning `Record<string, Tool>` — mirrors LangChain pattern with lazy initialization and graceful degradation
- [x] Apply tool factory: `createApplyTools(vectorStore: VectorStore, kubectlOptions?: KubectlOptions)` returning `Record<string, Tool>`
- [x] Each tool's execute function MUST be wrapped with `withToolTracing()` — this ensures tool spans (`<toolName>.tool`) have identical names and attributes regardless of which agent framework calls them
- [x] **Double-spanning concern**: The Vercel SDK's `experimental_telemetry` also creates `ai.toolCall` spans. Both our `withToolTracing()` spans AND the SDK's `ai.toolCall` spans will appear in traces. This is acceptable — they serve different purposes (ours have `cluster_whisperer.*` attributes; the SDK's have `ai.toolCall.*` attributes). Document this in M2's Weaver schema. Do NOT remove `withToolTracing()` — it's the shared contract between agents.
- [x] Unit tests for each wrapper: verify tool has correct description, `inputSchema` matches core schema, and `execute()` delegates to the core function with correct arguments

**Verification**:
- [x] `npm test` passes — new unit tests for all 5 Vercel tool wrappers pass
- [x] `npm run build` succeeds
- [x] Each wrapper test verifies: tool has correct `description` string (matches core export), `inputSchema` is the core Zod schema, and `execute()` delegates to the core function with the input parameters
- [x] Verify the factory functions return `Record<string, Tool>` objects (not arrays) — `streamText` requires this format

### M5: Vercel Agent Implementation
- [x] Create `src/agent/vercel-agent.ts` implementing the `InvestigationAgent` interface
- [x] Same system prompt as LangGraph agent — loaded from `prompts/investigator.md` using `path.join(__dirname, "../../prompts/investigator.md")` (same pattern as `src/agent/investigator.ts`)
- [x] Same Claude model: `claude-sonnet-4-20250514` (use the `ANTHROPIC_MODEL` constant exported from `src/agent/investigator.ts`)
- [x] The `investigate()` method calls `streamText` (from `'ai'`) with these exact parameters:
  ```typescript
  import { streamText, stepCountIs } from 'ai';
  import { anthropic } from '@ai-sdk/anthropic';

  const result = streamText({
    model: anthropic(ANTHROPIC_MODEL),
    system: systemPrompt,          // SDK 6 renamed to 'instructions' but 'system' still works
    prompt: question,              // For single-turn; or use messages: [...] for multi-turn
    tools: filteredTools,          // Record<string, Tool> from M4 factories
    stopWhen: stepCountIs(50),     // Matches RECURSION_LIMIT (SDK 6: NOT maxSteps)
    providerOptions: {
      anthropic: {
        thinking: { type: 'enabled', budgetTokens: 4000 },
        headers: { 'anthropic-beta': 'interleaved-thinking-2025-05-14' },
      },
    },
    experimental_telemetry: {
      isEnabled: true,
      functionId: 'cluster-whisperer-investigate',
      metadata: { agent: 'vercel' },
    },
  });
  ```
- [x] M1 CONFIRMED: Extended thinking with interleaved thinking IS supported. Enable it with `budgetTokens: 4000` + `anthropic-beta: interleaved-thinking-2025-05-14` header. "Thinking:" blocks will appear in CLI output for both agents.
- [x] The `investigate()` method translates `fullStream` parts into `AgentEvent` objects. The exact mapping (from M1 Q3, verified property names):
  ```typescript
  async function* investigate(question, options): AsyncIterable<AgentEvent> {
    let textBuffer = '';
    for await (const part of result.fullStream) {
      switch (part.type) {
        case 'reasoning-delta':
          yield { type: 'thinking', content: part.text };
          break;
        case 'tool-call':
          yield { type: 'tool_start', toolName: part.toolName, args: part.input };
          break;
        case 'tool-result':
          yield { type: 'tool_result', toolName: part.toolName, result: String(part.output) };
          break;
        case 'text-delta':
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
    // Edge case: if stream ends without finish-step with 'stop'
    if (textBuffer) {
      yield { type: 'final_answer', content: textBuffer };
    }
  }
  ```
  **RESOLVED property name inconsistency (vercel/ai#8756)**: M1 research documented `part.delta` but SDK 6 TypeScript types confirm `part.text` for both `reasoning-delta` and `text-delta` parts. Similarly, `tool-call` uses `part.input` (not `part.args`) and `tool-result` uses `part.output` (not `part.result`). The implementation uses the TypeScript-verified names with code comments documenting the finding.
- [x] Tool-set filtering: the agent factory passes the filtered `Record<string, Tool>` from M4's factories (merged via object spread: `{ ...kubectlTools, ...vectorTools, ...applyTools }`)
- [x] Agent factory integration: update the `case "vercel"` branch in `src/agent/agent-factory.ts` to construct and return the Vercel agent (replacing the "not yet implemented" error)

**Verification**:
- [x] `npm test` passes — unit tests for the Vercel agent mock `streamText` from `'ai'`, verify it's called with: correct model (`anthropic(ANTHROPIC_MODEL)`), system prompt, tools (Record shape), `stopWhen: stepCountIs(50)`, `providerOptions.anthropic.thinking`, and `experimental_telemetry.isEnabled: true`
- [x] `npm run build` succeeds with no TypeScript errors
- [x] `agent-factory.test.ts` updated: the "vercel" case now returns a valid `InvestigationAgent` instead of throwing
- [x] Manual test against a real cluster: `CLUSTER_WHISPERER_AGENT=vercel CLUSTER_WHISPERER_TOOLS=kubectl vals exec -i -f .vals.yaml -- node dist/index.js "What pods are running?"` completes successfully, shows tool calls and a final answer
- [x] Verify "Thinking:" blocks appear in italic in CLI output (interleaved thinking is confirmed working)
- [x] Verify the `fullStream` property names at runtime match the code — if `part.delta` doesn't work, update to `part.textDelta` or `part.text` and document the finding

### M6: Conversation Memory
- [x] Implement message history persistence for the Vercel agent's `--thread` flag using the SDK's `ModelMessage[]` format (renamed from `CoreMessage` in SDK 5→6)
- [x] The conversation memory lifecycle inside `investigate()`:
  1. **Load**: If `threadId` is provided, read `data/threads/vercel-<threadId>.json`. Parse as `ModelMessage[]`. If file missing or corrupt JSON → start fresh.
  2. **Build messages**: Combine prior messages + new user message:
     ```typescript
     const messages: ModelMessage[] = [
       ...priorMessages,
       { role: 'user', content: question },
     ];
     ```
     The system prompt is passed as the `system` parameter to `streamText`, NOT in the messages array.
  3. **Call streamText** with `messages` instead of `prompt` (multi-turn mode)
  4. **Save**: After the stream completes, get the new messages via `await result.response` → `response.messages` (returns `ModelMessage[]` containing all assistant + tool messages from ALL steps). Append to input messages and serialize:
     ```typescript
     const response = await result.response;
     const fullHistory = [...messages, ...response.messages];
     fs.writeFileSync(threadFile, JSON.stringify(fullHistory, null, 2));
     ```
- [x] File location: `data/threads/` directory (same as LangGraph checkpointer files from `src/agent/file-checkpointer.ts`)
- [x] File naming: `vercel-<threadId>.json` (prefixed to avoid collision with LangGraph thread files named `<threadId>.json`)
- [x] Handle edge cases: missing file (start fresh), corrupt JSON (start fresh — same pattern as `file-checkpointer.ts`), different thread IDs are independent, sanitize thread IDs for filesystem safety
- [x] `ModelMessage` objects are plain JSON-serializable — `JSON.stringify`/`JSON.parse` round-trips cleanly. No special serialization needed (unlike LangGraph's `MemorySaver` which has `Uint8Array` values requiring base64 encoding).

**Verification**:
- [x] Unit tests: round-trip save/load of conversation history (mirror the test patterns in `src/agent/file-checkpointer.test.ts`: fresh start, round-trip, directory creation, ID sanitization, corrupt file recovery, independent threads)
- [x] `npm test` passes with new unit tests
- [x] Manual test — run the Act 3a multi-turn conversation with the Vercel agent:
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
- [x] Verify: the second and third invocations reference information from prior turns
- [x] Verify: `data/threads/vercel-demo-vercel.json` file exists and contains valid JSON with `role: 'assistant'`, `role: 'tool'`, `role: 'user'` messages
- [x] Verify: tool calls in the serialized history have `{ type: 'tool-call', toolCallId, toolName, input }` parts and tool results have `{ type: 'tool-result', toolCallId, toolName, output }` parts (note: SDK 6 uses `input` not `args`)
- [x] Verify: deleting the thread file and re-running starts a fresh conversation

### M7: OTel Instrumentation
- [x] The `experimental_telemetry` config in M5's `streamText` call already enables telemetry. M7 focuses on verifying span nesting and context propagation.
- [x] **Context propagation via `tracer` parameter**: The SDK's `experimental_telemetry` accepts a `tracer` field. Pass our existing TracerProvider's tracer to ensure Vercel SDK spans nest under our root span:
  ```typescript
  import { trace } from '@opentelemetry/api';

  experimental_telemetry: {
    isEnabled: true,
    functionId: 'cluster-whisperer-investigate',
    tracer: trace.getTracer('ai'),  // Uses our registered TracerProvider
  }
  ```
  If this isn't sufficient for context propagation (same AsyncLocalStorage issue as LangGraph — see `src/tracing/context-bridge.ts`), wrap the `streamText` call with `withStoredContext()`.
- [x] The root investigation span is already provided by `withAgentTracing()` in `src/index.ts` (from M3 refactor) — framework-agnostic, no additional work needed
- [x] Tool execution spans are already provided by `withToolTracing()` in each Vercel tool's execute function (from M4) — no additional work needed
- [x] `setTraceOutput()` is already called when `final_answer` is received in the CLI loop (from M3 refactor) — no additional work needed
- [x] **Double tool spans are expected**: Both our `withToolTracing()` spans (`kubectl_get.tool`) and the SDK's `ai.toolCall` spans will appear. This is by design — our spans carry `cluster_whisperer.*` attributes for the shared contract; the SDK spans carry `ai.toolCall.*` attributes. Do NOT remove either.
- [x] **`gen_ai.*` attributes location**: The `gen_ai.system`, `gen_ai.request.model`, `gen_ai.usage.*` attributes are on `ai.streamText.doStream` spans (inner, per-step), NOT on the outer `ai.streamText` span. Datadog LLM Observability reads these from the inner spans — verify they appear correctly.
- [x] **SpanProcessor for Datadog LLM Obs layer classification (Decision 19)**: Create a `VercelSpanProcessor` (in `src/tracing/`) that enriches Vercel SDK spans on export by adding `gen_ai.operation.name` based on `ai.operationId`:
  - `ai.streamText.doStream` → add `gen_ai.operation.name: "chat"` → Datadog classifies as **llm** layer
  - `ai.streamText` → add `gen_ai.operation.name: "invoke_agent"` + `gen_ai.agent.name: "cluster-whisperer"` → Datadog classifies as **agent** layer
  - Follows existing `ToolDefinitionsProcessor` pattern in `src/tracing/index.ts`
- [x] **Fix root span `gen_ai.operation.name` (Decision 18)**: Change `withAgentTracing()` in `src/tracing/context-bridge.ts` — remove `gen_ai.operation.name: "chat"` from the root span so it defaults to **workflow** layer in Datadog. This affects both agents. The root span represents the investigation workflow, not an LLM call.
- [x] Register the `VercelSpanProcessor` in `src/tracing/index.ts` alongside the existing `ToolDefinitionsProcessor`
- [x] Unit tests for `VercelSpanProcessor`: verify it adds correct attributes based on `ai.operationId`
- [x] `npm test` and `npm run build` pass

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

- [x] Console output shows root span: name `cluster-whisperer.cli.investigate`, attribute `cluster_whisperer.invocation.mode: cli`
- [x] Console output shows our tool spans (e.g., `kubectl_get.tool`) with `gen_ai.tool.*` attributes (note: uses `gen_ai.*` convention, not `cluster_whisperer.*`)
- [x] Console output shows SDK tool spans with `ai.operationId: ai.toolCall` and `gen_ai.operation.name: execute_tool` (Updated per Decision 16: span name is `cluster-whisperer-investigate`, identified by `ai.operationId`)
- [x] Console output shows Vercel SDK LLM spans: outer `vercel.agent` (`ai.operationId: ai.streamText`) and inner `text.stream` (`ai.operationId: ai.streamText.doStream`) with `gen_ai.request.model` attribute (Updated per Decision 16: actual span names differ from predictions)
- [x] The `gen_ai.*` attributes (`gen_ai.system`, `gen_ai.request.model`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`) appear on `text.stream` spans (inner, per-step), NOT on the outer `vercel.agent` span
- [x] All spans share the same `traceId` (single trace, not fragmented — proves context propagation works)
- [x] Root span has `gen_ai.input.messages` attribute (requires `OTEL_CAPTURE_AI_PAYLOADS=true`)
- [x] After investigation completes, root span has `gen_ai.output.messages` attribute containing the final answer text
- [x] After SpanProcessor: Datadog LLM Obs shows **agent** layer (from `vercel.agent` span with `gen_ai.operation.name: invoke_agent`)
- [x] After SpanProcessor: Datadog LLM Obs shows **workflow** layer (from root span, no `gen_ai.operation.name`)
- [x] After SpanProcessor: Datadog LLM Obs shows **llm** layer (from `text.stream` spans with `gen_ai.operation.name: chat`)
- [x] After SpanProcessor: Datadog LLM Obs shows **tool** layer (from `kubectl_get.tool` spans with `gen_ai.operation.name: execute_tool`)

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

- [x] Trace appears in Datadog APM: search `service:cluster-whisperer`
- [x] Trace flame graph shows the expected span hierarchy (root → LLM calls → tool calls → subprocess)
- [x] Trace appears in Datadog LLM Observability with CONTENT column showing INPUT and OUTPUT (verified in UI — root workflow span shows JSON-formatted messages; LLM child spans show clean parsed content. Trade-off accepted: 4-layer classification prioritized over root span formatting)
- [x] Token usage is populated in the Datadog LLM Observability view (verified: "Input Tokens: 2.21K", "Input Cost: 0.66¢", "Output Tokens: 187", "Output Cost: 0.28¢")

**Target span hierarchy** (Updated per Decisions 16, 19 — actual runtime names + SpanProcessor enrichment):
```text
cluster-whisperer.cli.investigate          (root, withAgentTracing, Datadog: workflow)
├── vercel.agent                           (SDK outer, ai.operationId=ai.streamText, Datadog: agent)
│   ├── text.stream                        (step 1, ai.operationId=ai.streamText.doStream, Datadog: llm)
│   │   └── cluster-whisperer-investigate  (SDK tool, ai.operationId=ai.toolCall, Datadog: tool)
│   ├── text.stream                        (step 2, Datadog: llm)
│   │   └── cluster-whisperer-investigate  (SDK tool, Datadog: tool)
│   └── text.stream                        (step 3: final answer, Datadog: llm)
├── kubectl_get.tool                       (our withToolTracing span, gen_ai.tool.* attrs, Datadog: tool)
│   └── kubectl get pods                   (subprocess span)
└── kubectl_describe.tool                  (our withToolTracing span, Datadog: tool)
    └── kubectl describe pod demo-app-xxx  (subprocess span)
```
SpanProcessor adds `gen_ai.operation.name` to SDK spans: `text.stream` → `"chat"`, `vercel.agent` → `"invoke_agent"`.
Root span has `gen_ai.operation.name` removed so it defaults to workflow.
Note: Both `ai.toolCall` (SDK) and `<toolName>.tool` (ours) spans appear for each tool execution. They serve different observability purposes and coexist intentionally.

### M8: Equivalence Testing
- [x] Run both agents against the same demo scenario using the exact commands from `docs/choose-your-adventure-demo.md`

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

- [x] Both agents produce CLI output in this format (identical structure, content may vary):
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
- [x] Both agents identify CrashLoopBackOff and investigate with describe/logs
- [x] Both agents reach a conclusion about the missing database

**Test 2: Act 2 — CRD wall** (demonstrates the agent hitting limits without vector search):
```bash
cluster-whisperer "Do you know what database I should use?"
```
- [x] Both agents attempt `kubectl get crd` and struggle with the volume of CRDs

**Test 3: Act 3a — multi-turn conversation with vector search**:
```bash
export CLUSTER_WHISPERER_TOOLS=kubectl,vector
export CLUSTER_WHISPERER_THREAD=demo-equiv-test
cluster-whisperer "What database should I deploy for my app?"
cluster-whisperer "I'm not sure. My team is the You Choose team. I don't know if it's Postgres or MySQL."
cluster-whisperer "Yes please, will you deploy it for me?"
```
- [x] Agent finds multiple ManagedService results, asks follow-up questions
- [x] Agent narrows to `platform.acme.io` based on team name
- [x] Agent says it can't deploy (no apply tool)
- [x] Conversation memory works across all three invocations

**Test 4: Act 3b — deploy**:
```bash
export CLUSTER_WHISPERER_TOOLS=kubectl,vector,apply
cluster-whisperer "Go ahead and deploy it"
```
- [x] Agent deploys the ManagedService using kubectl_apply
- [x] The catalog validation works (only approved resource types can be deployed)

**Test 5: Trace comparison**:
- [x] Run Test 1 with both agents with `OTEL_TRACING_ENABLED=true OTEL_EXPORTER_TYPE=otlp`
- [x] Open both traces in Datadog
- [x] Root spans have identical names (`cluster-whisperer.cli.investigate`) and both map to **workflow** layer in Datadog (Updated per Decision 18: root span no longer has `gen_ai.operation.name: "chat"`)
- [x] Our tool spans have identical names (`kubectl_get.tool`, etc.) and identical `gen_ai.tool.*` attributes in both agents
- [x] LLM span names differ (expected: `anthropic.chat` for LangGraph via OpenLLMetry vs `text.stream` for Vercel via SDK `experimental_telemetry`) — both map to **llm** layer in Datadog (Updated per Decisions 16, 19: Vercel spans enriched by SpanProcessor with `gen_ai.operation.name: "chat"`)
- [x] Both agents' inner LLM spans carry `gen_ai.*` attributes (model, token usage) — verify Datadog LLM Observability shows token usage for both
- [x] Vercel traces have an **agent** layer (`vercel.agent` span with `gen_ai.operation.name: invoke_agent`) that LangGraph traces do not — this is acceptable asymmetry (Vercel SDK provides richer hierarchy)
- [x] Vercel traces have SDK `ai.toolCall` spans alongside our `<toolName>.tool` spans — both map to **tool** layer
- [x] Both traces tell a readable investigation story in the Datadog flame graph
- [x] Both traces show all expected layers in Datadog LLM Observability (at minimum: workflow, llm, tool for both; additionally agent for Vercel)

**Test 6: Save demo runs**:
- [x] Save full agent output from both agents to `demo/runs/` for comparison (same pattern as PRD #48 M11)
- [x] File names: `<timestamp>-vercel-act2.txt`, `<timestamp>-langgraph-act2.txt`, etc.

### M9: Documentation
- [x] Update README using `/write-docs` to document the Vercel agent and `--agent vercel` flag (Updated per Decision 22: also link to auto-generated attribute reference)
- [x] Update `docs/choose-your-adventure-demo.md` if any demo flow adjustments are needed — fixed `src/agent/vercel.ts` → `src/agent/vercel-agent.ts`; demo flow is agent-agnostic by design, no other changes needed
- [x] Update `docs/tracing-conventions.md` with Vercel-specific notes (Updated per Decisions 16-19, 21-22): Added Vercel Agent Tracing section with SDK telemetry config, LLM span name differences, VercelSpanProcessor mapping, Datadog layer table. Updated span hierarchy to show both agents. Updated Quick Reference files and span summary tables. Linked to auto-generated attribute reference.
- [x] Document the known property name inconsistency in the Vercel SDK (vercel/ai#8756) — added "SDK Property Name Inconsistency" section in tracing-conventions.md
- [x] Document that summarized thinking output means both agents show condensed reasoning — added "Summarized Thinking Output" section in tracing-conventions.md

**Verification**: All documentation changes reviewed. `docs/choose-your-adventure-demo.md` is accurate for both agent options. A new reader could understand `--agent vercel` and any behavioral differences from reading the docs alone. `npm run telemetry:docs` generates `docs/telemetry-generated/` successfully. Auto-generated attribute reference covers all 13 attribute groups.

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

Vercel tool definition (AI SDK 6 uses `inputSchema`, not `parameters`). The `tools`
parameter to `streamText` is `Record<string, Tool>` — tool names are object keys:
```typescript
import { tool } from 'ai';
import { kubectlGetSchema, kubectlGet, kubectlGetDescription } from '../core/kubectl-get';
import { withToolTracing } from '../../tracing/tool-tracing';

// Factory returns Record<string, Tool> for streamText's tools parameter
export function createKubectlTools(options?: KubectlOptions): Record<string, Tool> {
  return {
    kubectl_get: tool({
      description: kubectlGetDescription,
      inputSchema: kubectlGetSchema,
      execute: withToolTracing(
        { name: 'kubectl_get', description: kubectlGetDescription },
        async (input) => {
          const { output } = await kubectlGet(input, options);
          return output;
        }
      ),
    }),
    // ... kubectl_describe, kubectl_logs
  };
}
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
        console.log(`🔧 Tool: ${event.toolName}`);
        console.log(`   Args: ${JSON.stringify(event.args)}`);
        break;
      case "tool_result":
        console.log(`   Result:\n${truncate(event.result, 1100)}`);
        console.log();
        break;
      case "final_answer":
        finalAnswer = event.content;
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
that emits all events during a multi-step agent run. SDK 6 uses start/delta/end patterns.
The `AgentEvent` adapter iterates over `fullStream` and translates part types:

- `'reasoning-delta'` (with `delta`) → `AgentEvent.thinking`
- `'tool-call'` (with `toolName`, `input`) → `AgentEvent.tool_start`
- `'tool-result'` (with `toolName`, `output`) → `AgentEvent.tool_result`
- `'text-delta'` (with `delta`) → accumulate for `AgentEvent.final_answer`
- `'finish-step'` (with `finishReason`, `stepType`) → detect final step to emit final answer

**Property name caution**: M1 found a known inconsistency (vercel/ai#8756) between
TypeScript types and runtime values for the text property on delta parts. The implementation
should try `part.delta` first; if it's undefined at runtime, fall back to `part.textDelta`
or `(part as any).text`. Document whichever works.

The SDK also offers lifecycle callbacks (`onStepFinish`, `experimental_onToolCallStart`,
`experimental_onToolCallFinish`) as supplements, but the stream parts are sufficient.

For extended thinking, `fullStream` emits `reasoning-delta` parts between tool calls when
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

The Vercel agent manages conversation memory manually via `ModelMessage[]` (SDK 6 type,
renamed from `CoreMessage` in SDK 5):
1. After each investigation, get new messages via `await result.response` → `response.messages` (returns `ModelMessage[]` with all assistant + tool messages from all steps)
2. Combine input messages + response messages → serialize to `data/threads/vercel-<threadId>.json`
3. On resume: deserialize, append new user message, pass as `messages` parameter to `streamText`
4. System prompt is passed as the `system` parameter, NOT in the messages array
5. `ModelMessage` objects are plain JSON-serializable — no special encoding needed (unlike LangGraph's `Uint8Array` values requiring base64)

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
| 2026-03-16 | Accept double tool spans in Vercel traces | The SDK's `ai.toolCall` spans AND our `withToolTracing()` spans (`<toolName>.tool`) coexist intentionally. Removing either loses information: SDK spans carry `ai.toolCall.*` attributes; ours carry `cluster_whisperer.*` attributes for the shared contract. Documented in M2 Weaver schema and M7 span hierarchy. |
| 2026-03-16 | Use `tracer` parameter for context propagation | `experimental_telemetry` accepts a `tracer` field to pass our TracerProvider. This ensures Vercel SDK spans nest under our root `cluster-whisperer.cli.investigate` span. Avoids the AsyncLocalStorage context loss that LangGraph had (OpenLLMetry-JS #476). |
| 2026-03-16 | `response.messages` for conversation serialization | After `streamText` completes, `await result.response` → `response.messages` returns `ModelMessage[]` — the exact round-trip format. System prompt goes in the `system` parameter, NOT in the messages array. Plain JSON serializable (no base64 encoding needed unlike LangGraph's `MemorySaver`). |
| 2026-03-16 | `gen_ai.*` attributes only on inner `doStream` spans | Datadog LLM Observability reads `gen_ai.system`, `gen_ai.request.model`, `gen_ai.usage.*` from `ai.streamText.doStream` spans, NOT from the outer `ai.streamText` span. This is how the SDK works — not configurable. |
| 2026-03-16 | Property name inconsistency requires runtime verification | vercel/ai#8756 — `reasoning-delta` and `text-delta` parts may have `delta`, `textDelta`, or `text` as the property name depending on the API layer. M5 must verify against actual runtime values and document which works. |
| 2026-03-16 | M1–M4 don't need a cluster | Spin up GCP cluster when starting M5. |
| 2026-03-16 | Vercel SDK span names differ from M1 predictions (Decision 16) | Runtime verification revealed `vercel.agent` (not `ai.streamText`) and `text.stream` (not `ai.streamText.doStream`). The `ai.operationId` attribute preserves the original names. See `docs/research/49-m7-datadog-llmobs-otel-mapping.md`. |
| 2026-03-16 | No OpenLLMetry instrumentation for Vercel AI SDK (Decision 17) | Confirmed: openllmetry-js has 13 instrumentation packages but none for the Vercel AI SDK. The `@traceloop/instrumentation-anthropic` instruments the underlying Anthropic calls for LangGraph but not the Vercel SDK layer. |
| 2026-03-16 | Datadog LLM Obs requires `gen_ai.operation.name` for layer classification (Decision 18) | Without this attribute, spans default to "workflow" regardless of other gen_ai.* attributes. The Vercel SDK's LLM spans have all gen_ai.* attributes EXCEPT `gen_ai.operation.name`. Root span's `gen_ai.operation.name: "chat"` is wrong for both agents — makes Datadog classify it as LLM instead of workflow. Full mapping: `docs/research/49-m7-datadog-llmobs-otel-mapping.md`. |
| 2026-03-16 | SpanProcessor to enrich Vercel SDK spans for Datadog (Decision 19) | Add a SpanProcessor that sets `gen_ai.operation.name` on Vercel SDK spans based on `ai.operationId`: `ai.streamText.doStream` → `"chat"` (llm layer), `ai.streamText` → `"invoke_agent"` (agent layer). Also fix root span from `"chat"` → remove (workflow layer). Non-invasive, follows existing `ToolDefinitionsProcessor` pattern. Produces all 4 Datadog layers: agent, workflow, llm, tool. |
| 2026-03-16 | Weaver schema audit: 4 missing attributes + VercelSpanProcessor attributes (Decision 20) | Schema audit found `cluster_whisperer.agent.framework`, `cluster_whisperer.catalog.approved`, `cluster_whisperer.k8s.resource_kind`, `cluster_whisperer.k8s.api_group` set in code but not in schema. Also `gen_ai.agent.name`, `ai.operationId`, and `gen_ai.operation.name` on Vercel spans. All added. New `kubectl_apply` attribute group created. |
| 2026-03-16 | Auto-generate attribute reference from Weaver schema (Decision 21) | Use `weaver registry generate` with official OTel semconv markdown templates to produce `docs/telemetry-generated/`. This is the single source of truth for attribute definitions. Hand-written `docs/tracing-conventions.md` keeps architecture and design rationale only — remove its hand-maintained attribute tables to prevent drift. Added `npm run telemetry:docs` script. |
| 2026-03-16 | Generated docs complement, don't replace hand-written docs (Decision 22) | `docs/telemetry-generated/attributes/cluster-whisperer.md` is the auto-generated attribute reference (what attributes exist). `docs/tracing-conventions.md` is the hand-written architecture guide (why spans are structured this way, context propagation, design decisions). Both are linked from README. |
