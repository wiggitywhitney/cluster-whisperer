# PRD #121: Kyverno Admission Control

**Status**: Complete (2026-04-07)
**Priority**: High
**Created**: 2026-04-05
**GitHub Issue**: wiggitywhitney/cluster-whisperer#121
**Depends on**: PRD #120 (ServiceAccount RBAC must exist for policy scoping)
**Branch**: `feature/prd-121-kyverno`

---

## Problem

Application-layer guardrails (tool catalog, session state gate, RBAC) all live inside the application. A real platform enforcement layer should work regardless of how a request arrives — through the MCP server, raw `kubectl`, a CI pipeline, or any other path. That's what admission control provides.

Kyverno is a Kubernetes admission controller that enforces policies at the cluster level. A Kyverno ClusterPolicy rejecting a non-approved resource produces a real error from the cluster itself, not a custom string from application code. This is better for the demo, better for production, and is where the platform engineering industry is heading.

This PRD replaces the tool catalog entirely with Kyverno. Once Kyverno is in place, `kubectl_apply` in PRD #120 removes its catalog validation and simply applies — trusting the cluster to enforce policy.

---

## Policy Strategy: Allowlist for Demo

For the KCD Austin demo, an allowlist is cleaner and more dramatic: only approved resource types can be created through the agent. Everything else is blocked at admission.

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: cluster-whisperer-resource-allowlist
spec:
  validationFailureAction: Enforce
  background: false  # subjects matching only works on live admission requests, not background scans
  rules:
    - name: require-approved-resources
      match:
        any:
          - resources:
              kinds: ["*"]  # required by Kyverno — resources block must have at least one kind
              operations: ["CREATE"]
            subjects:
              - kind: ServiceAccount
                name: cluster-whisperer-mcp
                namespace: cluster-whisperer
      validate:
        message: "Only ManagedService resources from platform.acme.io are allowed through the cluster whisperer agent."
        deny:
          conditions:
            any:
              - key: "{{ request.object.apiVersion }}"
                operator: NotEquals
                value: "platform.acme.io/v1alpha1"
              - key: "{{ request.object.kind }}"
                operator: NotEquals
                value: "ManagedService"
```

**Critical**: The policy is scoped to the `cluster-whisperer-mcp` ServiceAccount via the `subjects` block. This means:
- Crossplane is unaffected — it uses its own ServiceAccount
- System operations are unaffected — excluded by ServiceAccount scoping
- Only requests from the Cluster Whisperer MCP server are checked

---

## Prompt Guidance Still Matters

Kyverno handles enforcement but prompt guidance handles intent. Without scope guidance in the `kubectl_apply` tool description, the AI coding assistant might repeatedly attempt to create resources that Kyverno will reject, burning the conversation trying. Prompt guidance is the first line — Kyverno is the backstop. Both are necessary; they do different jobs.

## What Kyverno Produces in the Demo

When the AI tries to create a non-approved resource, `kubectl apply` returns:

```text
Error from server: admission webhook "validate.kyverno.svc" denied the request:
[require-approved-resources] only ManagedService resources from platform.acme.io are allowed.
```

The AI coding assistant (Claude Code) surfaces this to the developer in natural language. The audience sees a real cluster rejection, not application code. The Kyverno ClusterPolicy YAML can be shown on screen — it's human-readable, declarative, and lives in the cluster.

---

## Production Considerations (beyond demo scope)

For a real deployment, the allowlist approach is supplemented with compliance policies:
- Require resource limits on all containers
- Require specific labels (team, environment)
- Block privileged containers
- Block creation in system namespaces

These are out of scope for the KCD demo but worth mentioning in the talk as where this pattern scales.

---

## Milestones

### Milestone 1: Kyverno Installation ✅ Complete
**Step 0:** Read related research before starting: [Research: Kyverno Helm Install on GKE](../../docs/research/kyverno-helm-install.md)
- [x] Add Kyverno to the demo cluster setup (Helm chart or kubectl apply)
- [x] Verify Kyverno admission webhook is running and intercepting requests
- [x] Document install command in demo setup docs

**Success criteria**: `kubectl get pods -n kyverno` shows Kyverno running. A test policy blocks a test resource.

### Milestone 2: ClusterPolicy — Resource Allowlist ✅ Complete
**Step 0:** Read related research before starting: [Research: Kyverno Helm Install on GKE](../../docs/research/kyverno-helm-install.md)

*Decision 1 resolved: SA-scoped policy (Option 2). Write the policy scoped to `cluster-whisperer-mcp` SA — this is the correct production form. Verify using `kubectl --as` impersonation now; the policy fires automatically once the MCP server runs in-cluster (future PRD). See Decision Log.*

<<<<<<<< HEAD:prds/done/55-kyverno-admission-control.md
- [x] **Decide demo scoping strategy**: SA-scoped policy chosen (Decision 1). Policy is correct as written in this PRD's Policy Strategy section.
- [x] Write `k8s/kyverno-allowlist.yaml` with SA scoping and `background: false`
- [x] **Verify Kyverno policy syntax**: Applied to GKE cluster. Rejection confirmed via `kubectl --as=system:serviceaccount:cluster-whisperer:cluster-whisperer-mcp` — ConfigMap create blocked with clear Kyverno error. See Decision 3 for `kinds: ["*"]` fix required during apply.
- [x] Test: creating a ManagedService as the SA succeeds; creating a Pod as the SA is rejected with the Kyverno error message
- [x] Test: Crossplane operations are unaffected (Crossplane uses its own SA, policy won't match)
- [x] Test: system ServiceAccounts are unaffected

**Success criteria**: SA-scoped policy applied to cluster. Rejection verified via `kubectl --as` impersonation. A non-approved create is blocked with a clear Kyverno error message. The policy is verified against the actual Kyverno version running in the cluster.

### Milestone 3: Remove Tool Catalog from `kubectl_apply` ✅ Complete
*This is the only place the catalog removal happens. PRD #54 M4 leaves the catalog in place until this milestone runs.*

- [x] Remove catalog validation from `kubectl_apply` core function
- [x] `kubectl_apply` now: parse YAML → run `kubectl apply` → return result (including Kyverno errors)
- [x] The session state gate from PRD #54 M4 remains — Kyverno does not replace it
- [x] Verify: Kyverno rejection errors surface cleanly to Claude Code
========
### Milestone 3: Remove Tool Catalog from `kubectl_apply`
*This is the only place the catalog removal happens. PRD #120 M4 leaves the catalog in place until this milestone runs.*

- [ ] Remove catalog validation from `kubectl_apply` core function
- [ ] `kubectl_apply` now: parse YAML → run `kubectl apply` → return result (including Kyverno errors)
- [ ] The session state gate from PRD #120 M4 remains — Kyverno does not replace it
- [ ] Verify: Kyverno rejection errors surface cleanly to Claude Code
>>>>>>>> origin/main:prds/121-kyverno-admission-control.md

**Success criteria**: `kubectl_apply` is simpler. Kyverno handles admission enforcement. The session state gate handles application-layer enforcement. The two layers are complementary, not redundant.

### Milestone 4: Demo Polish

*Note: items 1 and 2 are deferred — see Decisions 4 and 5.*

- [~] Show Kyverno ClusterPolicy YAML in the talk slide deck (deferred — no slide deck exists yet; Decision 4)
- [~] Demonstrate a rejection live via Claude Code (deferred — requires in-cluster MCP; tracked in PRD #122 M4; Decision 5)
- [x] Document the full demo flow in `docs/talk/`

**Success criteria**: The Kyverno demo moment is polished and tells the guardrails story convincingly.

---

## Decision Log

| # | Date | Decision | Rationale |
|---|------|----------|-----------|
| 1 | 2026-04-06 | SA-scoped policy (Option 2) for demo | SA scoping is the correct production form — fires based on request identity, not namespace. Aligns with Viktor Farcic's reference architecture (in-cluster MCP). Impersonation (Option 1) requires MCP code changes; namespace scoping (Option 3) weakens the guardrails story. M2 verifies via `kubectl --as` now; live Claude Code rejection fires automatically once MCP runs in-cluster. |
| 2 | 2026-04-06 | In-cluster MCP deployment needs a new PRD | PRD #53 explicitly excludes MCP-over-HTTP. No existing PRD covers in-cluster MCP server deployment (switching from stdio to Streamable HTTP transport + Kubernetes Deployment). This gap means M4's live rejection demo is blocked until that PRD is written and merged. |
| 3 | 2026-04-06 | `kinds: ["*"]` required in resources block | Kyverno v1.17.1 rejects ClusterPolicy at apply time if `resources` has no `kinds` entry, even when using `subjects` scoping. The original PRD policy example omitted `kinds`. Fix: add `kinds: ["*"]` to capture all resource types and let deny conditions filter. Documented in `~/.claude/rules/kyverno-gotchas.md`. |
| 4 | 2026-04-07 | Defer slide deck work to a future PRD | No slide deck exists yet — creating one is out of scope for this PRD. When a slide deck PRD is created, the Kyverno ClusterPolicy YAML slide should be included as a milestone item. |
| 5 | 2026-04-07 | Live rejection demo tracked in PRD #122 M4 | PRD #122 (In-Cluster MCP Server Deployment) M4 explicitly covers end-to-end Kyverno rejection verification via Claude Code. No separate work needed here — PRD #55 M4 item 2 is fully covered downstream. |

## References

- PRD #120: MCP native tools and ServiceAccount RBAC (prerequisite)
- Kyverno docs: https://kyverno.io/docs/
- KCD Texas abstract: `kcd-texas-abstract.md`
