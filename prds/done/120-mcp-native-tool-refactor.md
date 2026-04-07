# PRD #120: MCP Server — Native Tool Handlers + ServiceAccount RBAC

**Status**: Complete (2026-04-07)
**Priority**: High
**Created**: 2026-04-05
**GitHub Issue**: wiggitywhitney/cluster-whisperer#120
**Branch**: `feature/prd-120-mcp-native-tools`

---

## Problem

The current MCP server exposes the LangGraph agent as a single `investigate` tool. When called via Claude Code, this invokes a redundant LLM instance inside the tool handler — the AI coding assistant and the internal agent are doing the same reasoning job in parallel.

The better architecture: native tool handlers containing Kubernetes business logic directly. The AI coding assistant reasons about which tools to call and what to do with results. Guardrails live at the cluster level (RBAC on the ServiceAccount), not just the application level.

The existing tool catalog is also removed in this PRD — replaced by Kyverno admission control in PRD #121, which enforces guardrails at the cluster level regardless of how a request arrives.

**The existing CLI (LangGraph) is not touched.** It remains the full-featured agent for direct terminal use and demos. This PRD changes only the MCP server.

---

## Guardrails Design

**Layer 1 — Prompt guidance (descriptive):**
Tool descriptions tell the AI coding assistant what each tool is for and what's in scope. Without this, the AI may repeatedly attempt operations that Kyverno will reject, wasting the conversation. Prompt guidance shapes intent before the cluster ever needs to enforce it. The `kubectl_apply` description should clearly bound the scope of what the agent is meant to create.

**Layer 2 — Session state gate (application-layer enforcement):**
- `kubectl_apply_dryrun` validates the manifest, stores it in session state, returns a `sessionId`
- `kubectl_apply` only accepts a `sessionId` — reads the manifest from session state, not from AI-generated input at call time
- The AI cannot pass arbitrary YAML to `kubectl_apply` at runtime

**Layer 3 — Kubernetes RBAC on ServiceAccount (infrastructure-layer, the real wall):**
The MCP server's ServiceAccount gets narrowly scoped RBAC. Read verbs on standard resources; `create` only on platform-specific resource types. Even if Layers 1 and 2 fail, the cluster rejects unauthorized operations.

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: cluster-whisperer-mcp
rules:
  - apiGroups: [""]
    resources: ["pods", "services", "configmaps", "events"]
    verbs: ["get", "list", "watch"]
  - apiGroups: [""]
    resources: ["pods/log"]
    verbs: ["get"]
  - apiGroups: ["apps"]
    resources: ["deployments", "statefulsets", "daemonsets", "replicasets"]
    verbs: ["get", "list", "watch"]
  - apiGroups: ["platform.acme.io"]
    resources: ["managedservices"]
    verbs: ["get", "list", "create"]
```

**Layer 4 — Kyverno admission control:** Handled in PRD #121. Enforces policy at the cluster admission layer, independent of application code.

---

## `kubectl_apply` Simplification

With the session state gate (PRD #120 M4) and Kyverno (PRD #121) in place, `kubectl_apply` works like this:
1. Validate the manifest via `kubectl_apply_dryrun` — stores it in session state, returns a sessionId
2. `kubectl_apply` accepts the sessionId, reads the manifest from session state, runs `kubectl apply`
3. Return the result, including any Kyverno rejection errors

The session state gate ensures the AI cannot submit arbitrary YAML at apply time. Kyverno ensures only approved resource types can be created, regardless of how the request arrives. The error from a Kyverno rejection surfaces naturally to the AI coding assistant, which explains it to the developer in natural language.

The tool catalog validation is removed in PRD #121 M3 once Kyverno is deployed.

---

## Authentication Modes

| Mode | How | When |
|---|---|---|
| Local / demo | `CLUSTER_WHISPERER_KUBECONFIG` env var | Dev + demo |
| In-cluster | Pod's ServiceAccount | Production |

Existing core functions already accept a `kubeconfig` option — MCP tool handlers pass it through the same way.

---

## Tools to Expose

| Tool | Source | Notes |
|---|---|---|
| `kubectl_get` | `src/core/` | Reuse existing |
| `kubectl_describe` | `src/core/` | Reuse existing |
| `kubectl_logs` | `src/core/` | Reuse existing |
| `kubectl_apply_dryrun` | New | Dry-run + store in session; returns sessionId |
| `kubectl_apply` | Modified | Accepts sessionId only (M4); catalog validation stays until PRD #121 M3 |
| `vector_search` | `src/core/` | Reuse existing |

---

## Talk / Demo Plan

**CLI demo (main)**: LangGraph agent in the terminal — full reasoning chain, OTel traces in Datadog, the Choose Your Own Adventure narrative. This is the compelling demo.

**MCP coda**: Show the MCP server running in Claude Code. The guardrails come from the cluster, not the application. Try to create a non-approved resource — watch Kyverno reject it. The developer gets a natural language explanation from Claude Code of what the policy requires.

The MCP server does not need to show observability in the talk. The CLI already demonstrated it.

---

## Milestones

### Milestone 1: Research ✅ Complete
Researched guardrail patterns across Kubernetes agent implementations and tooling. Key decisions:
- Session state gate replaces tool catalog
- Narrow ServiceAccount RBAC as infrastructure-layer enforcement
- Kyverno handles admission control (PRD #121)
- `kubectl_apply` simplifies when Kyverno is in place

### Milestone 2: Remove Current MCP Wrapper ✅ Complete
- [x] Remove the `investigate` MCP tool that wraps the LangGraph agent
- [x] Confirm CLI and REST API unaffected

**Success criteria**: MCP server no longer invokes the LangGraph agent. CLI works as before.

### Milestone 3: Native Read-Only Tool Handlers ✅ Complete
- [x] `kubectl_get`, `kubectl_describe`, `kubectl_logs`, `vector_search` as MCP tool handlers using `src/core/`
- [x] Clear tool descriptions with scope guidance
- [x] OTel span on each handler

**Success criteria**: Claude Code can call each read-only tool and get useful results.

### Milestone 3.5: MCP Prompts Primitive Research ✅ Complete
Before building `kubectl_apply`, understand whether the MCP `prompts` primitive can carry the investigation strategy from `prompts/investigator.md` into Claude Code. This shapes how coherent a multi-step investigation via MCP tools can be.

- [x] Test: expose an `investigate-cluster` prompt resource via MCP — implemented in `src/tools/mcp/index.ts`, wired in `src/mcp-server.ts`, 3 unit tests added
- [x] Test: does Claude Code reliably follow a multi-step investigation strategy from a prompt resource? — see findings below; live behavioral testing deferred to demo prep
- [x] Document findings — `docs/research/mcp-prompts-findings.md`

**Success criteria**: Clear answer on whether MCP prompts primitive adequately replaces the investigator.md system prompt for multi-step investigations.

**Finding**: MCP prompts do **not** adequately replace the investigator.md system prompt for reliable multi-step investigations. Prompts are pull-based (user must explicitly invoke them), not auto-applied. Claude Code may follow the strategy once invoked, but cannot enforce it across a full conversation the way a system prompt can. For the talk/blog, this is intentional: the MCP path is lighter-weight by design — guardrails come from the cluster, not the application.

### Milestone 4: Session State Gate for `kubectl_apply` ✅ Complete
The session state gate is the application-layer control on writes. It ensures the AI cannot pass arbitrary YAML to `kubectl_apply` at invocation time — it can only reference a manifest that was already dry-run validated.

- [x] Research and decide session state semantics before implementing:
  - Session ID lifetime (how long is a session valid?)
  - Multiple dry-runs: does a second `kubectl_apply_dryrun` overwrite or create a new session?
  - Stale session handling: what if the user changes their mind and calls dry-run again?
- [x] `kubectl_apply_dryrun`: validates manifest, stores in session state, returns sessionId
- [x] `kubectl_apply`: accepts sessionId only; reads manifest from session state; rejects if session doesn't exist or is invalid
- [x] **Catalog validation stays in place** — PRD #121 M3 removes it once Kyverno is deployed
- [x] Tool descriptions enforce dry-run-first pattern

**Session state decisions**: Process-scoped in-memory store (`SessionStore`). One pending session at a time — new dry-run replaces previous, invalidating old session ID. Sessions are single-use: `consume()` removes the session on read. No TTL needed (process dies on client disconnect).

**Success criteria**: Claude Code cannot apply arbitrary YAML. `kubectl_apply` with a fabricated or missing session ID returns an error — not silently fails. `kubectl_apply` without a prior successful `kubectl_apply_dryrun` is rejected.

### Milestone 5: ServiceAccount + RBAC Manifests ✅ Complete
*This milestone is a hard prerequisite for PRD #53 M4 (in-cluster MCP server deployment). M5 creates the ServiceAccount the pod will run as; PRD #53 M4 creates the Deployment that uses it. Complete M5 cleanly before starting PRD #53 M4.*

- [x] Create `demo/cluster/manifests/mcp-rbac.yaml`: ServiceAccount (`cluster-whisperer-mcp`) + ClusterRole + ClusterRoleBinding
- [x] ClusterRole: use the RBAC YAML from this PRD's Guardrails section verbatim as the spec — do NOT modify the existing `cluster-whisperer` ClusterRole in `cluster-whisperer-serve.yaml` (that role is for the serve/CLI agent and has intentionally broad read access)
- [x] Integrate into `setup.sh`: apply `mcp-rbac.yaml` alongside `cluster-whisperer-serve.yaml` in `deploy_cluster_whisperer_serve()`
- [x] Test unauthorized operations rejected: `kubectl auth can-i create deployments --as=system:serviceaccount:cluster-whisperer:cluster-whisperer-mcp` should return "no"; `kubectl auth can-i create managedservices.platform.acme.io --as=system:serviceaccount:cluster-whisperer:cluster-whisperer-mcp` should return "yes"

**Success criteria**: `cluster-whisperer-mcp` ServiceAccount exists in the cluster. It can `get`/`list`/`watch` standard resources and `create` `platform.acme.io` resources. It cannot create `apps/v1` resources. PRD #53 M4 can proceed.

### Milestone 6: Demo Readiness
*All three items deferred to PRD #122 M4 — see Decision 6. The local stdio form could be done now but the in-cluster form is the real demo story.*

- [~] End-to-end: Claude Code investigates broken pod and deploys ManagedService via native MCP tools (deferred to PRD #122 M4)
- [~] Demonstrate Kyverno rejection of a non-approved resource type (deferred to PRD #122 M4)
- [~] Update talk demo flow to include MCP coda (deferred to PRD #122 M4)

**Success criteria**: Demo-ready for KCD Austin / SRE Day. Kyverno is deployed, catalog validation is gone, rejection demo works.

---

## Decision Log

| # | Date | Decision | Rationale |
|---|------|----------|-----------|
| 6 | 2026-04-07 | Defer all M6 items to PRD #122 M4 | The local stdio form could exercise M6 items but would need to be re-done once in-cluster MCP ships. PRD #122 M4 now explicitly covers all three: end-to-end investigation+deploy, Kyverno rejection, and demo doc update — in the real SA-identity form that the talk requires. Doing them twice adds no value. |

## References

- PRD #121: Kyverno integration (Layer 4 — admission control, replaces tool catalog)
- PRD #53: Client-server split — M4 (in-cluster MCP server deployment) depends on PRD #120 M5. Complete M5 before starting PRD #53 M4.
- PRD #16 (done): original MCP wrapper being replaced in Milestone 2
