# PRD #53: Client-Server Architecture Split

**Status**: Not Started
**Priority**: Medium (post-conference)
**Dependencies**: PRD #48 (demo modifications, serve mode infrastructure), PRD #49 (Vercel agent — both agents must work through the serve endpoint)
**Execution Order**: After PRD #49 — the conference demo uses Option C (kubeconfig pass-through). This PRD builds the real governance architecture afterward.
**Branch**: `feature/prd-53-client-server-split`

> **Architecture note**: A separate architectural decision is pending about whether to refactor the MCP server from a LangGraph agent wrapper to native MCP tool handlers. That decision affects the shape of this PRD. Read the research before starting work here:
> [cluster-whisperer-architecture-research.md](https://github.com/wiggitywhitney/journal/blob/main/cluster-whisperer-architecture-research.md)

## Problem

The cluster-whisperer CLI currently runs the agent locally. The user must have a
kubeconfig with cluster access, API keys for the LLM, and network access to vector
databases. This means:

1. **No real credential separation** — the developer has the same cluster access as the
   agent. The governance narrative ("platform team controls what the developer can do
   through the agent") is demonstrated via environment variable separation (PRD #48
   Option C), but not enforced architecturally.
2. **Credential sprawl** — every developer who uses cluster-whisperer needs API keys
   (Anthropic, Voyage) and a kubeconfig. In a real platform team deployment, these
   should live on the server.
3. **No multi-user access** — only one person at a time can use the CLI. A serve
   endpoint enables multiple developers to interact with the same agent infrastructure.

The serve mode already runs in-cluster with a ServiceAccount, RBAC, API keys, and
vector DB access. It just doesn't have an investigation endpoint.

## Solution

Add an investigation endpoint to the serve mode and a thin-client mode to the CLI.

**Server side**: `POST /api/v1/investigate` accepts a question and optional configuration
(tool groups, vector backend), runs the agent server-side using the existing LangGraph or
Vercel agent, and streams reasoning events back via Server-Sent Events (SSE).

**Client side**: When `CLUSTER_WHISPERER_URL` is set, the CLI skips local agent creation,
POSTs the question to the serve endpoint, reads the SSE stream, and renders events using
the same console output logic (thinking blocks, tool calls, results, final answer). The
rendering code barely changes — only the event source swaps.

**Reference architecture**: [vfarcic/dot-ai](https://github.com/vfarcic/dot-ai) — server-only
architecture with MCP + REST API co-hosted on same HTTP server, plugin-based tools,
clients never get cluster access.

## Success Criteria

- `CLUSTER_WHISPERER_URL=http://serve.example.com cluster-whisperer "question"` sends the question to the serve endpoint and streams back the agent's reasoning
- Without `CLUSTER_WHISPERER_URL`, the CLI runs the agent locally (backwards compatible)
- The CLI output is identical regardless of local or remote execution
- The serve endpoint supports both LangGraph and Vercel agents (via request parameter or server config)
- OTel traces appear in Jaeger/Datadog attributed to the serve pod's ServiceAccount
- The serve deployment's ServiceAccount has write RBAC for `kubectl_apply` operations
- The client machine requires zero cluster credentials, zero API keys, zero vector DB access

## Non-Goals

- Authentication/authorization on the serve endpoint (internal network assumption, same as current endpoints)
- Multi-tenant isolation (single-team use case for now)
- WebSocket support (SSE is sufficient for unidirectional streaming)
- Replacing the local CLI mode (it remains valuable for development and testing)
- MCP protocol over HTTP (dot-ai does this, but cluster-whisperer's MCP server is stdio-based and serves a different purpose)

## Milestones

### M1: Investigation Endpoint with SSE Streaming
- [ ] `POST /api/v1/investigate` Hono route accepting `{ question, toolGroups?, agentType?, vectorBackend? }`
- [ ] Server-side agent creation using existing `createAgent()` factory
- [ ] `streamEvents()` output serialized as SSE events: `thinking`, `tool_call`, `tool_result`, `answer`, `error`
- [ ] SSE event format documented and versioned
- [ ] Error handling for mid-stream failures (agent errors, tool failures, timeouts)
- [ ] Concurrency control (max concurrent investigations, similar to capability scan's in-flight limit)
- [ ] Non-streaming mode: `Accept: application/json` returns complete result (for CI, scripts, MCP-over-HTTP later)
- [ ] Unit tests using Hono's `app.request()` test pattern
- [ ] Integration test: POST question → receive SSE stream → verify event sequence

### M2: CLI Thin-Client Mode
- [ ] `CLUSTER_WHISPERER_URL` env var detection in CLI
- [ ] When set: skip local agent creation, POST to `${url}/api/v1/investigate`
- [ ] SSE stream reader that parses events into the same format as local `streamEvents()`
- [ ] Existing rendering logic (thinking → italic, tool calls → emoji, results → truncated) works with remote events
- [ ] `--tools`, `--agent`, `--vector-backend` flags forwarded as request parameters
- [ ] Connection error handling (server unreachable, timeout, stream interrupted)
- [ ] Unit tests for SSE parsing and event rendering
- [ ] Integration test: CLI → serve endpoint → full investigation cycle

### M3: Write RBAC for kubectl_apply
- [ ] Update serve deployment's ClusterRole to include write permissions for kubectl_apply resource types
- [ ] Scope write permissions to resources in the capabilities catalog (not cluster-wide write)
- [ ] Verify: agent running via serve endpoint can successfully apply approved resources
- [ ] Verify: agent cannot apply resources outside the catalog (tool-level enforcement still works)

### M4: OTel Context for Remote Execution
- [ ] Root span created on serve side (not CLI side) for remote investigations
- [ ] Span attributes include: question, agent type, tool groups, vector backend
- [ ] Tool spans (kubectl, vector search) are children of the investigation span
- [ ] CLI does NOT create duplicate spans when in thin-client mode
- [ ] Verified: traces in Jaeger show complete investigation flow attributed to serve pod
- [ ] W3C trace context propagation: CLI can optionally send traceparent header for correlation

### M5: End-to-End Verification and Documentation
- [ ] Full investigation cycle: CLI (no kubeconfig) → serve endpoint → agent investigates → results streamed back
- [ ] Both agent types (LangGraph, Vercel) work through the endpoint
- [ ] Both vector backends (Chroma, Qdrant) work through the endpoint
- [ ] Traces visible in Jaeger/Datadog for both agent types
- [ ] Update README with serve-mode investigation documentation
- [ ] Update `docs/choose-your-adventure-demo.md` if demo switches to thin-client mode
- [ ] Document deployment architecture (who runs the server, who uses the CLI)

## Technical Design

### SSE Event Format

```text
event: thinking
data: {"content": "Let me check what pods are running..."}

event: tool_call
data: {"name": "kubectl_get", "args": {"resource": "pods", "namespace": "default"}}

event: tool_result
data: {"name": "kubectl_get", "content": "NAME  READY  STATUS..."}

event: answer
data: {"content": "Your app is broken because..."}

event: error
data: {"message": "Agent failed: ...", "code": "AGENT_ERROR"}
```

### Request Shape

```text
POST /api/v1/investigate
Content-Type: application/json
Accept: text/event-stream

{
  "question": "Why is my app broken?",
  "toolGroups": ["kubectl", "vector", "apply"],
  "agentType": "langgraph",
  "vectorBackend": "qdrant"
}
```

### CLI Event Source Abstraction

The CLI rendering code in `index.ts` currently consumes LangGraph's `streamEvents()` async
iterator directly. This PRD refactors the rendering to consume an abstract event stream:

```text
Local mode:   agent.streamEvents() → normalize → render
Remote mode:  fetch(SSE) → parse → normalize → render
                                      ↑
                              Same event shape
```

The normalization layer converts either source into a common `InvestigationEvent` type.
The rendering code doesn't know or care where events come from.

### Existing Code That's Reusable

| Component | Location | Reuse |
|-----------|----------|-------|
| Agent creation | `src/agent/agent-factory.ts` | Direct reuse on server side |
| Stream event handling | `src/index.ts` lines 222-312 | Refactor into shared renderer |
| OTel tracing middleware | `src/api/tracing-middleware.ts` | Already on all serve routes |
| Zod validation | `src/api/schemas/` | Pattern for request validation |
| Hono app factory | `src/api/server.ts` | Add new route alongside existing |
| MCP invoke pattern | `src/tools/mcp/index.ts` `invokeInvestigator()` | Reference for non-streaming agent invocation |

### What dot-ai Does Differently

dot-ai is fully server-side — no local CLI mode at all. cluster-whisperer keeps both:
- **Local mode** (no `CLUSTER_WHISPERER_URL`): agent runs locally, useful for development,
  testing, and environments where the user has cluster access
- **Remote mode** (`CLUSTER_WHISPERER_URL` set): thin client to serve endpoint, useful for
  production deployments where credential separation matters

This dual-mode approach means the CLI must work identically in both modes. The event
rendering code is the contract — if a user can't tell whether they're in local or remote
mode from the output alone, the implementation is correct.

## Decision Log

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-03-13 | Deferred to post-conference | PRD #48 Option C (kubeconfig pass-through) is sufficient for the KubeCon demo. This PRD builds the real architecture afterward. PRD #49 (Vercel agent) delivers more audience value. |
| 2026-03-13 | SSE over WebSocket | Unidirectional streaming (server → client) is all that's needed. SSE is simpler, works with standard HTTP, and Hono has built-in support. |
| 2026-03-13 | Keep local CLI mode | Local mode is valuable for development and testing. Don't force all usage through the serve endpoint. dot-ai is server-only because it targets a different use case (always-on MCP server for AI assistants). |
| 2026-03-13 | OTel root span on server | When running via serve endpoint, the server does the work, so the server owns the trace. The CLI is just a display client. This is more correct for the governance story (traces attributed to the platform's ServiceAccount, not the developer's machine). |
