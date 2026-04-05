# PRD #54: MCP Server — Native Tool Handlers + ServiceAccount RBAC

**Status**: In Progress (research complete)
**Priority**: High
**Created**: 2026-04-05
**Branch**: `feature/prd-54-mcp-native-tools`

---

## Problem

The current MCP server exposes the LangGraph agent as a single `investigate` tool. When called via Claude Code, this invokes a redundant LLM instance inside the tool handler — the AI coding assistant and the internal agent are doing the same reasoning job in parallel.

The better architecture: native tool handlers containing Kubernetes business logic directly. The AI coding assistant reasons about which tools to call and what to do with results. Guardrails live at the cluster level (RBAC on the ServiceAccount), not just the application level.

The existing tool catalog is also removed in this PRD — replaced by Kyverno admission control in PRD #55, which enforces guardrails at the cluster level regardless of how a request arrives.

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

**Layer 4 — Kyverno admission control:** Handled in PRD #55. Enforces policy at the cluster admission layer, independent of application code.

---

## `kubectl_apply` Simplification

With the session state gate (PRD #54 M4) and Kyverno (PRD #55) in place, `kubectl_apply` works like this:
1. Validate the manifest via `kubectl_apply_dryrun` — stores it in session state, returns a sessionId
2. `kubectl_apply` accepts the sessionId, reads the manifest from session state, runs `kubectl apply`
3. Return the result, including any Kyverno rejection errors

The session state gate ensures the AI cannot submit arbitrary YAML at apply time. Kyverno ensures only approved resource types can be created, regardless of how the request arrives. The error from a Kyverno rejection surfaces naturally to the AI coding assistant, which explains it to the developer in natural language.

The tool catalog validation is removed in PRD #55 M3 once Kyverno is deployed.

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
| `kubectl_apply` | Modified | Accepts sessionId only; removes catalog validation |
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
- Kyverno handles admission control (PRD #55)
- `kubectl_apply` simplifies when Kyverno is in place

### Milestone 2: Remove Current MCP Wrapper
- [ ] Remove the `investigate` MCP tool that wraps the LangGraph agent
- [ ] Confirm CLI and REST API unaffected

**Success criteria**: MCP server no longer invokes the LangGraph agent. CLI works as before.

### Milestone 3: Native Read-Only Tool Handlers
- [ ] `kubectl_get`, `kubectl_describe`, `kubectl_logs`, `vector_search` as MCP tool handlers using `src/core/`
- [ ] Clear tool descriptions with scope guidance
- [ ] OTel span on each handler

**Success criteria**: Claude Code can call each read-only tool and get useful results.

### Milestone 3.5: MCP Prompts Primitive Research
Before building `kubectl_apply`, understand whether the MCP `prompts` primitive can carry the investigation strategy from `prompts/investigator.md` into Claude Code. This shapes how coherent a multi-step investigation via MCP tools can be.

- [ ] Test: expose an `investigate-cluster` prompt resource via MCP
- [ ] Test: does Claude Code reliably follow a multi-step investigation strategy from a prompt resource?
- [ ] Document findings — even if implementation is deferred, findings inform the blog post and talk

**Success criteria**: Clear answer on whether MCP prompts primitive adequately replaces the investigator.md system prompt for multi-step investigations.

### Milestone 4: Session State Gate for `kubectl_apply`
The session state gate is the application-layer control on writes. It ensures the AI cannot pass arbitrary YAML to `kubectl_apply` at invocation time — it can only reference a manifest that was already dry-run validated.

- [ ] Research and decide session state semantics before implementing:
  - Session ID lifetime (how long is a session valid?)
  - Multiple dry-runs: does a second `kubectl_apply_dryrun` overwrite or create a new session?
  - Stale session handling: what if the user changes their mind and calls dry-run again?
- [ ] `kubectl_apply_dryrun`: validates manifest, stores in session state, returns sessionId
- [ ] `kubectl_apply`: accepts sessionId only; reads manifest from session state; rejects if session doesn't exist or is invalid
- [ ] **Catalog validation stays in place** — PRD #55 M3 removes it once Kyverno is deployed
- [ ] Tool descriptions enforce dry-run-first pattern

**Success criteria**: Claude Code cannot apply arbitrary YAML. `kubectl_apply` with a fabricated or missing session ID returns an error — not silently fails. `kubectl_apply` without a prior successful `kubectl_apply_dryrun` is rejected.

### Milestone 5: ServiceAccount + RBAC Manifests
- [ ] Create `k8s/mcp-rbac.yaml`: ServiceAccount + ClusterRole + ClusterRoleBinding
- [ ] ClusterRole: read verbs on standard resources, `create` only on platform resource types
- [ ] Configure in-cluster auth to use ServiceAccount credentials
- [ ] Test: unauthorized operations rejected at cluster level

**Success criteria**: ServiceAccount cannot create arbitrary resources. Cluster enforces this.

### Milestone 6: Demo Readiness
*Depends on PRD #55 M3 (catalog removal) for the full demo flow — the Kyverno rejection moment requires Kyverno to be deployed and the catalog validation removed. Do not close this PRD until PRD #55 M3 is complete.*

- [ ] End-to-end: Claude Code investigates broken pod and deploys ManagedService via native MCP tools
- [ ] Demonstrate Kyverno rejection of a non-approved resource type
- [ ] Update talk demo flow to include MCP coda

**Success criteria**: Demo-ready for KCD Austin / SRE Day. Kyverno is deployed, catalog validation is gone, rejection demo works.

---

## References

- PRD #55: Kyverno integration (Layer 4 — admission control, replaces tool catalog)
- PRD #53: Client-server split (separate concern)
- PRD #16 (done): original MCP wrapper being replaced in Milestone 2
