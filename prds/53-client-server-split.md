# PRD #53: Client-Server Architecture Split

**Status**: Not Started
**Priority**: High (KubeCon happened — post-conference work is now active)
**Dependencies**: PRD #48 (demo modifications, serve mode infrastructure), PRD #120 (MCP native tool handlers + RBAC — prerequisite for M4 below)
**Execution Order**: PRD #120 M5 (ServiceAccount + RBAC manifests) is a prerequisite for M4 below.
**Branch**: `feature/prd-53-client-server-split`

> **Architecture decisions made**: The MCP server native tool refactor is implemented in PRD #120. Kyverno admission control is implemented in PRD #121. The serve endpoint runs the same LangGraph agent as the CLI — not a separate implementation. In-cluster MCP server deployment with HTTP transport is now in scope (see Decision 5, M4 below).

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

## Milestones

### M1: Investigation Endpoint with SSE Streaming
- [ ] Step zero: read `docs/architecture-research.md` for context on why this endpoint exists and how it fits the overall architecture
- [ ] `POST /api/v1/investigate` Hono route accepting `{ question, toolGroups?, agentType?, vectorBackend? }`
- [ ] Server-side agent creation using existing `createAgent()` factory (LangGraph — same agent as the CLI)
- [ ] `streamEvents()` output serialized as SSE events: `thinking`, `tool_call`, `tool_result`, `answer`, `error`
- [ ] SSE event format documented and versioned
- [ ] Error handling for mid-stream failures (agent errors, tool failures, timeouts)
- [ ] Concurrency control (max concurrent investigations) — follow the in-flight limit pattern in `src/api/routes/capabilities.ts`
- [ ] Non-streaming mode: `Accept: application/json` returns complete result (for CI, scripts, MCP-over-HTTP later)
- [ ] Unit tests using Hono's `app.request()` test pattern
- [ ] Integration test: POST question → receive SSE stream → verify event sequence

**Success criteria**: `POST /api/v1/investigate` returns an SSE stream with at least one `thinking`, one `tool_call`, and one `answer` event for a valid question. `Accept: application/json` returns a complete result object. Both streaming and non-streaming paths have passing tests.

### M2: CLI Thin-Client Mode
- [ ] Step zero: read `docs/architecture-research.md`
- [ ] `CLUSTER_WHISPERER_URL` env var detection in CLI
- [ ] When set: skip local agent creation, POST to `${url}/api/v1/investigate`
- [ ] SSE stream reader that parses events into the same format as local `streamEvents()`
- [ ] Existing rendering logic (thinking → italic, tool calls → emoji, results → truncated) works with remote events
- [ ] `--tools`, `--agent`, `--vector-backend` flags forwarded as request parameters
- [ ] Connection error handling (server unreachable, timeout, stream interrupted)
- [ ] Unit tests for SSE parsing and event rendering
- [ ] Integration test: CLI → serve endpoint → full investigation cycle

**Success criteria**: `CLUSTER_WHISPERER_URL=http://localhost:3000 cluster-whisperer "why is my pod broken"` produces identical terminal output to local mode. The CLI has zero knowledge of whether it's local or remote — output is the contract.

### M3: Write RBAC for kubectl_apply
*Note: enforcement strategy has evolved since this PRD was written. PRD #121 (Kyverno) is the primary enforcement layer; this milestone covers the ServiceAccount RBAC side.*

- [ ] Step zero: read `docs/architecture-research.md`

- [ ] Update serve deployment's ClusterRole to include create permissions for approved resource types (see PRD #121 for allowlist — currently `platform.acme.io/v1alpha1/ManagedService`)
- [ ] Verify: agent running via serve endpoint can successfully apply approved resources
- [ ] Verify: Kyverno ClusterPolicy (PRD #121) provides admission-level enforcement for the serve ServiceAccount (MCP ServiceAccount verification is owned by PRD #120 M5)

**Success criteria**: The serve deployment's ServiceAccount can `kubectl apply` a `platform.acme.io/v1alpha1/ManagedService`. Attempting to create a `apps/v1/Deployment` is rejected. Kyverno enforcement verified end-to-end.

### M4: In-Cluster MCP Server Deployment
*Prerequisite: PRD #120 M5 (ServiceAccount + RBAC manifests). The MCP server runs as a pod using its ServiceAccount directly — no kubeconfig needed.*

- [ ] Step zero: read `docs/architecture-research.md`
- [ ] Research step: run `/research MCP Streamable HTTP transport` — `src/mcp-server.ts` currently uses `StdioServerTransport`; understand how to switch to `StreamableHTTPServerTransport`, what port/path conventions to use, and how Claude Code's `.mcp.json` should reference an HTTP server. Document findings before writing code.
- [ ] Decide and implement entrypoint: add an `--http` flag to the existing `mcp-server` binary so one image serves both modes (stdio for local, HTTP for in-cluster)
- [ ] Create `demo/cluster/manifests/mcp-server.yaml`: Deployment using the cluster-whisperer image with `--http` flag, ServiceAccount from PRD #120 M5
- [ ] Stdio transport for local development must remain unchanged — the `--http` flag only activates HTTP mode
- [ ] Apply manifests in `setup.sh` alongside the serve deployment
- [ ] Configure Claude Code to connect via HTTP transport (update `.mcp.json`)
- [ ] Test: Claude Code can call MCP tools against the in-cluster server with no local kubeconfig

**Success criteria**: The MCP server runs in-cluster as a pod. Claude Code connects via HTTP transport. The pod's ServiceAccount RBAC is the only cluster access — no local kubeconfig required. Stdio mode for local development is unaffected.

### M5: OTel Context for Remote Execution
- [ ] Root span created on serve side (not CLI side) for remote investigations
- [ ] Span attributes include: question, agent type, tool groups, vector backend
- [ ] Tool spans (kubectl, vector search) are children of the investigation span
- [ ] CLI does NOT create duplicate spans when in thin-client mode
- [ ] Verified: traces in Jaeger show complete investigation flow attributed to serve pod
- [ ] W3C trace context propagation: CLI can optionally send traceparent header for correlation

### M6: End-to-End Verification and Documentation
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
| MCP native tool handlers | `src/tools/mcp/index.ts` | Reference for how core tool functions are wrapped (PRD #120) |

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
| 2026-04-06 | Post-conference is now active | KubeCon happened. PRD priority raised to High. Work can begin. |
| 2026-04-06 | Serve endpoint uses LangGraph (same as CLI) | The serve endpoint runs the same full-featured agent as the CLI — `createAgent()` factory. The MCP server refactor (PRD #120) is specific to the MCP path; it does not affect the CLI or serve endpoint. Architecture research (`docs/architecture-research.md`) raised whether the serve endpoint should use a simpler Anthropic SDK loop, but LangGraph is confirmed for both CLI and serve. |
| 2026-04-06 | In-cluster MCP server deployment is in scope (M4) | Running the MCP server as a pod (instead of a local stdio process) enables real credential separation for Claude Code users: no local kubeconfig, no local API keys. Uses MCP's Streamable HTTP transport. Prerequisite: PRD #120 M5 (ServiceAccount + RBAC manifests). See `docs/architecture-research.md` for full context. |
