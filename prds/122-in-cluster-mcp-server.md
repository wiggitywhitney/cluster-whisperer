# PRD #122: In-Cluster MCP Server Deployment

**Status**: Not Started
**Priority**: High (required for KubeCon demo)
**Created**: 2026-04-06
**GitHub Issue**: wiggitywhitney/cluster-whisperer#122
**Branch**: `feature/prd-122-in-cluster-mcp-server` *(create from main after PRD #120 and #121 are merged)*
**Depends on**:
- PRD #54/55 M5: `cluster-whisperer-mcp` ServiceAccount + RBAC must exist ✅
- PRD #55 M2: Kyverno SA-scoped policy must be applied (policy fires on SA identity)

**Unblocks**:
- PRD #54/120 M6: Demo readiness (live Kyverno rejection via Claude Code)
- PRD #55 M4: Demo polish (live rejection moment requires in-cluster MCP)

---

## Problem

The MCP server currently runs as a local stdio process — Claude Code launches it as a child process and communicates over stdin/stdout. This means every `kubectl` call from the MCP server authenticates as the local kubeconfig user, not the `cluster-whisperer-mcp` ServiceAccount.

The Kyverno admission policy (PRD #55) is scoped to the `cluster-whisperer-mcp` ServiceAccount via the `subjects` block. When the MCP server runs locally, the Kyverno policy never matches and the live rejection demo moment cannot fire.

Running the MCP server in-cluster as a pod solves this cleanly: the pod runs as the `cluster-whisperer-mcp` SA, kubectl calls inherit SA identity, and the Kyverno policy fires naturally. No impersonation flags, no code workarounds.

---

## Architecture

### Current (stdio)

```text
Claude Code → spawns → mcp-server process (local)
                            ↓ kubectl (authenticates as kubeconfig user)
                         GKE cluster
```

### Target (Streamable HTTP)

```text
Claude Code → HTTP → cluster-whisperer-mcp Service → mcp-server Pod (SA: cluster-whisperer-mcp)
                                                            ↓ kubectl (authenticates as SA)
                                                         GKE cluster
```

### Transport Reference

The MCP spec supports two transport modes:
- **stdio**: Client spawns server as local process. Used today.
- **Streamable HTTP**: Client connects to server over HTTP. Required for in-cluster deployment.

Viktor Farcic's dot-ai uses Streamable HTTP exclusively — his MCP server runs in-cluster and clients connect over HTTP. That is the reference pattern for this PRD. See `docs/research/viktors-pipeline-assessment.md` and `docs/research/mcp-research.md`.

### What Does NOT Change

- Tool handler logic in `src/tools/mcp/index.ts` — transport-agnostic
- Tool descriptions, session state gate
- The LangGraph CLI path (unaffected by MCP transport)
- The REST investigation endpoint (separate from MCP)

---

## Demo Form

For the KubeCon demo, Claude Code's `.mcp.json` points at the in-cluster MCP service via the existing ingress (same nip.io pattern used for Jaeger and cluster-whisperer serve). No port-forwarding needed on stage.

When Claude Code calls `kubectl_apply` to create a non-ManagedService resource, the request arrives at the cluster as `cluster-whisperer-mcp` SA → Kyverno fires → rejection error surfaces in Claude Code's response. The audience sees a real cluster rejection.

---

## Milestones

### Milestone 1: Streamable HTTP Transport

**Step 0:** Read `docs/research/mcp-research.md` for MCP SDK transport options and patterns before implementing.

The MCP SDK supports Streamable HTTP via `StreamableHTTPServerTransport`. The server needs an HTTP framework to host it — Hono is already used in this project (`src/api/server.ts`).

- [ ] Run `/research mcp streamable http transport` before writing any code — SDK APIs for this transport have changed across versions; confirm the current module path and constructor signature
- [ ] Replace stdio transport in `src/mcp-server.ts` with Streamable HTTP transport — Do NOT keep stdio as a fallback or dev-mode option (Decision 4)
- [ ] Wire into the existing Hono server so the MCP endpoint is served on port 3457 (distinct from serve port to avoid conflicts)
- [ ] Verify: local `curl` can reach the MCP endpoint; Claude Code can connect via `.mcp.json` HTTP config
- [ ] Unit tests for HTTP transport initialization

**Success criteria**: MCP server accepts connections over HTTP. Claude Code can call `kubectl_get` through the HTTP transport and receive results.

### Milestone 2: Kubernetes Deployment Manifest

The `cluster-whisperer-mcp` ServiceAccount is defined in `demo/cluster/manifests/mcp-rbac.yaml`, which is introduced by PRD #120 M5. **This branch must be started after PRD #120 merges** — the manifest does not exist on main until then. This milestone adds the Deployment that runs as that SA.

- [ ] Create `demo/cluster/manifests/mcp-server.yaml`: Deployment + Service for the MCP server pod
  - `spec.serviceAccountName: cluster-whisperer-mcp`
  - Same image as `cluster-whisperer-serve` (already built and pushed by setup.sh)
  - Env vars: `CLUSTER_WHISPERER_KUBECONFIG` is NOT needed in-cluster — pod uses SA token automatically
  - Port: 3457 (same port chosen in M1)
- [ ] Add ingress rule for MCP server (same nip.io pattern as Jaeger/serve)
- [ ] Integrate into `setup.sh`: apply `mcp-server.yaml` in `deploy_cluster_whisperer_serve()` alongside existing manifests
- [ ] Verify: pod runs as `cluster-whisperer-mcp` SA, `kubectl auth can-i` from inside pod matches expected RBAC

**Success criteria**: MCP server pod running in cluster, accessible via ingress URL, operating as `cluster-whisperer-mcp` SA.

### Milestone 3: Claude Code Configuration

Update `.mcp.json` to connect via HTTP instead of spawning a local process.

**Step 0:** Check the current `.mcp.json` format and the MCP spec for the HTTP transport config shape before editing — the URL field name and transport type key are spec-defined and easy to get wrong.

- [ ] Update `.mcp.json` to use HTTP transport pointing at the in-cluster MCP service URL
- [ ] Update `demo/.env` generation in `setup.sh` to include the MCP server ingress URL (`CLUSTER_WHISPERER_MCP_URL`)
- [ ] Document in demo runbook: how to configure Claude Code to use in-cluster MCP
- [ ] Verify: Claude Code connects to in-cluster MCP, all tools (`kubectl_get`, `kubectl_describe`, `kubectl_logs`, `vector_search`, `kubectl_apply_dryrun`, `kubectl_apply`) work end-to-end

**Success criteria**: Claude Code uses in-cluster MCP server. No local MCP process needed. All 6 tools functional.

### Milestone 4: End-to-End Demo Verification

Full demo verification with in-cluster MCP: investigation, deployment, and Kyverno enforcement — all using real SA identity.

*Absorbs deferred items from PRD #120 M6 (items 1 and 3) and PRD #55 M4 (item 2). The local stdio MCP could test these in isolation, but the in-cluster form is the real demo story: SA identity, Kyverno enforcement, and the full audience-facing narrative.*

- [ ] End-to-end: Claude Code investigates broken pod and deploys ManagedService via in-cluster MCP tools
- [ ] Attempt `kubectl_apply` with a non-ManagedService resource via Claude Code → confirm Kyverno error fires
- [ ] Attempt `kubectl_apply` with a ManagedService via Claude Code → confirm it succeeds
- [ ] Confirm Crossplane operations are unaffected (its SA is not the MCP SA)
- [ ] Update `docs/talk/` demo docs (rehearsal runbook + demo flow) to include the MCP coda

**Success criteria**: Claude Code, connected to the in-cluster MCP server, can investigate a broken pod, deploy the fix, and get a real Kyverno rejection when attempting a non-approved resource. Demo docs reflect the final in-cluster form.

---

## Decision Log

| # | Date | Decision | Rationale |
|---|------|----------|-----------|
| 1 | 2026-04-06 | Streamable HTTP (not WebSocket) | Streamable HTTP and WebSocket are separate MCP transports — WebSocket is not standardized by the MCP spec (2025-11-25). The TypeScript SDK's `StreamableHTTPServerTransport` implements Streamable HTTP (HTTP POST/GET with optional SSE streaming), not WebSocket. SSE is already used for the investigation endpoint (PRD #53 M1). |
| 2 | 2026-04-06 | Co-host on existing Hono server | MCP HTTP endpoint added to existing `src/api/server.ts` rather than a separate process. One pod, same image — two listener ports (serve/REST on its existing port, MCP on 3457). Fewer moving parts than a dedicated MCP pod. |
| 3 | 2026-04-06 | No CLUSTER_WHISPERER_KUBECONFIG in-cluster | In-cluster pods authenticate via mounted SA token automatically. Passing a kubeconfig would conflict. The existing `executeKubectl` already handles in-cluster auth (no `--kubeconfig` flag when env var is unset). |
| 4 | 2026-04-06 | Replace stdio transport, do not keep alongside | stdio is only useful for local development. Once in-cluster is the target, maintaining two transport modes adds complexity with no benefit. The LangGraph CLI path is unaffected (it never used MCP). |
| 5 | 2026-04-06 | MCP HTTP port: 3457 | Distinct from the serve/REST API port to avoid conflicts. Concrete port pinned in the PRD so M1 and M2 share a single source of truth rather than M2 depending on M1's output. |

---

## References

- `docs/research/mcp-research.md` — MCP SDK transport options, tool registration patterns
- `docs/research/viktors-pipeline-assessment.md` — Viktor's in-cluster MCP reference architecture
- `docs/research/kyverno-helm-install.md` — Kyverno cluster context (SA scoping)
- PRD #54/120: MCP native tool handlers (tool logic this PRD deploys)
- PRD #55: Kyverno admission control (what this PRD unblocks)
- PRD #53: Client-server split (post-conference, separate concern)
- MCP spec — Streamable HTTP transport: https://modelcontextprotocol.io/docs/concepts/transports
