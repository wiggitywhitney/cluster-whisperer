# PRD #54: MCP Server — Native Tool Handlers

**Status**: Not Started
**Priority**: High
**Created**: 2026-04-05
**Branch**: `feature/prd-54-mcp-native-tools`

---

## Problem

The current MCP server wraps the LangGraph agent as a single `investigate` tool. This means calling Cluster Whisperer via MCP invokes a redundant LLM instance inside the tool handler. The better architecture is an MCP server that exposes granular native tools — each tool does one thing (query the cluster, search the vector DB, apply a resource), and the AI coding assistant reasons about what to call and in what order.

Additionally, cluster-side authentication and access control are not scoped — the current implementation uses whatever cluster credentials the user has. For a real platform deployment, the MCP server should authenticate with a ServiceAccount that has narrowly scoped RBAC permissions, enforcing guardrails at the infrastructure layer rather than the application layer.

---

## Solution

Build a new MCP server alongside the existing CLI (which stays as-is). The new MCP server exposes native tools reusing the existing core layer. Cluster access is scoped to a ServiceAccount with explicit RBAC permissions. Prompt guidance describes what the tools can and cannot do; cluster-side RBAC enforces it.

**The existing CLI (LangGraph) is not touched.** It remains the full-featured agent for direct terminal use and demos.

---

## Tools to Expose

| Tool | Description |
|---|---|
| `kubectl_get` | Get Kubernetes resources by type and namespace |
| `kubectl_describe` | Describe a specific resource |
| `kubectl_logs` | Fetch logs from a pod |
| `vector_search` | Search the cluster's capability knowledge base by natural language |
| `kubectl_apply` | Apply a Kubernetes resource (with guardrails — see below) |

All reuse existing functions from `src/core/`. No new business logic needs to be written — this is a new exposure layer for existing code.

---

## Guardrails

**Cluster-side (primary enforcement):**
- ServiceAccount with RBAC limited to `get`, `describe`, `logs` for read operations
- `kubectl_apply` scoped to specific resource types / namespaces allowed by RBAC
- Even if the AI tries to delete or modify something unauthorized, the cluster rejects it

**Prompt guidance (secondary, descriptive):**
- Tool descriptions state what each tool is for and what it should not be used for
- System prompt / MCP prompt describes the intended use of `kubectl_apply` (adding capabilities, not removing or modifying existing app resources)

**Open question (research milestone):**
How to limit what `kubectl_apply` can create? Viktor's dot-ai repo may have solved this — see Milestone 1.

---

## Talk / Demo Plan

**CLI demo (main):** Show the LangGraph agent in the terminal — full reasoning chain, full observability (OTel traces → Datadog), the Choose Your Own Adventure narrative. This is the compelling demo.

**MCP coda:** After the CLI demo, show the MCP server running in Claude Code. Discuss: the CLI is great, but developers are increasingly working in AI coding agents. The MCP server meets them there. Guardrails are at the cluster level. You don't need a separate agent — your coding assistant already is one.

The MCP server does not need to show observability in the talk — the CLI already demonstrated that.

---

## Milestones

### Milestone 1: Research — Guardrails and Viktor's Approach
- [ ] Study Viktor Farcic's [dot-ai repo](https://github.com/vfarcic/dot-ai) — how does he handle cluster-side guardrails? How does he limit what `kubectl_apply` can do?
- [ ] Understand how his approach differs between a CLI agent and an MCP server
- [ ] Document: how to scope `kubectl_apply` — which resource types, which namespaces, what RBAC policy enforces it
- [ ] Document: prompt guidance pattern for what the intelligence can and cannot apply to the cluster
- [ ] Research: how to set up a Kubernetes ServiceAccount with narrowly scoped RBAC for the MCP server

**Success criteria**: Clear design for cluster-side auth + RBAC + `kubectl_apply` guardrails, informed by real examples.

### Milestone 2: Remove Current MCP Wrapper
- [ ] Remove the `investigate` MCP tool that wraps the LangGraph agent
- [ ] Confirm CLI and REST API are unaffected

**Success criteria**: MCP server no longer invokes the LangGraph agent. CLI and REST API work as before.

### Milestone 3: Expose Native MCP Tools
- [ ] Implement `kubectl_get`, `kubectl_describe`, `kubectl_logs` as MCP tool handlers using `src/core/`
- [ ] Implement `vector_search` as an MCP tool handler
- [ ] Implement `kubectl_apply` with guardrails from Milestone 1 design
- [ ] Write tool descriptions that give the AI coding assistant clear guidance on what each tool does and doesn't do
- [ ] Add OTel spans to each tool handler (individual tool-level tracing)

**Success criteria**: Claude Code can call each tool individually and get useful results. `kubectl_apply` respects the guardrails.

### Milestone 4: Cluster Authentication + RBAC
- [ ] Create a ServiceAccount with scoped RBAC for the MCP server
- [ ] Configure MCP server to authenticate using the ServiceAccount credentials
- [ ] Test: verify the ServiceAccount cannot exceed its permissions regardless of what Claude Code requests

**Success criteria**: MCP server authenticates to cluster with minimal permissions. Unauthorized operations are rejected at the cluster level.

### Milestone 5: Demo Readiness
- [ ] End-to-end test: Claude Code investigates a broken pod using the native MCP tools
- [ ] Test the `kubectl_apply` guardrails in the demo scenario (ManagedService deployment)
- [ ] Update talk demo flow to include MCP coda

**Success criteria**: MCP server is demo-ready for KCD Austin / SRE Day.

---

## References

- [docs/architecture-research.md](../docs/architecture-research.md) — architecture decision and research background
- Viktor Farcic's dot-ai: https://github.com/vfarcic/dot-ai
- PRD #53: client-server split (separate concern, unaffected by this PRD)
- PRD #16 (done): original MCP wrapper being replaced
