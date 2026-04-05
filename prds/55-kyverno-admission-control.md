# PRD #55: Kyverno Admission Control

**Status**: Not Started
**Priority**: High
**Created**: 2026-04-05
**Depends on**: PRD #54 (ServiceAccount RBAC must exist for policy scoping)
**Branch**: `feature/prd-55-kyverno`

---

## Problem

Application-layer guardrails (tool catalog, session state gate, RBAC) all live inside the application. A real platform enforcement layer should work regardless of how a request arrives — through the MCP server, raw `kubectl`, a CI pipeline, or any other path. That's what admission control provides.

Kyverno is a Kubernetes admission controller that enforces policies at the cluster level. A Kyverno ClusterPolicy rejecting a non-approved resource produces a real error from the cluster itself, not a custom string from application code. This is better for the demo, better for production, and is where the platform engineering industry is heading.

This PRD replaces the tool catalog entirely with Kyverno. Once Kyverno is in place, `kubectl_apply` in PRD #54 removes its catalog validation and simply applies — trusting the cluster to enforce policy.

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
  rules:
    - name: require-approved-resources
      match:
        any:
          - resources:
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

### Milestone 1: Kyverno Installation
- [ ] Add Kyverno to the demo cluster setup (Helm chart or kubectl apply)
- [ ] Verify Kyverno admission webhook is running and intercepting requests
- [ ] Document install command in demo setup docs

**Success criteria**: `kubectl get pods -n kyverno` shows Kyverno running. A test policy blocks a test resource.

### Milestone 2: ClusterPolicy — Resource Allowlist
- [ ] Write `k8s/kyverno-allowlist.yaml` with the policy above
- [ ] Scope to `cluster-whisperer-mcp` ServiceAccount
- [ ] Test: creating a ManagedService succeeds; creating a Pod is rejected
- [ ] Test: Crossplane operations are unaffected
- [ ] Test: system ServiceAccounts are unaffected

**Success criteria**: Only ManagedService resources can be created via the Cluster Whisperer ServiceAccount. All other create operations are rejected with a clear error message.

### Milestone 3: Remove Tool Catalog from `kubectl_apply`
- [ ] Remove catalog validation from `kubectl_apply` core function
- [ ] `kubectl_apply` now: parse YAML → run `kubectl apply` → return result (including Kyverno errors)
- [ ] Verify: Kyverno rejection errors surface cleanly to Claude Code

**Success criteria**: `kubectl_apply` is simpler. Kyverno handles enforcement. The error message from a rejection is informative and Claude Code can explain it naturally.

### Milestone 4: Demo Polish
- [ ] Show Kyverno ClusterPolicy YAML in the talk slide deck
- [ ] Demonstrate a rejection live: ask Claude Code to create a non-approved resource, show the Kyverno error, show Claude Code's natural language explanation
- [ ] Document the full demo flow in `docs/talk/`

**Success criteria**: The Kyverno demo moment is polished and tells the guardrails story convincingly.

---

## References

- PRD #54: MCP native tools and ServiceAccount RBAC (prerequisite)
- Kyverno docs: https://kyverno.io/docs/
- KCD Texas abstract: `kcd-texas-abstract.md`
