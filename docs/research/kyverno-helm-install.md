# Research: Kyverno Helm Install on GKE

**Project:** cluster-whisperer
**Last Updated:** 2026-04-06

## Update Log

| Date | Summary |
|------|---------|
| 2026-04-06 | Initial research — Helm install command, version mapping, subjects syntax, GKE firewall gotcha |

---

## Findings

### Summary

Install Kyverno via Helm using chart `kyverno/kyverno` from `https://kyverno.github.io/kyverno/`. The current stable chart version is **3.7.1** (Helm chart version), which deploys Kyverno **app version v1.17.1** (February 2026). The two version numbers are independent; always use the chart version for Helm, the app version is what runs in the cluster.

---

### Surprises and Gotchas

**1. Two independent version numbers — do not confuse them.**
- Helm chart version: `3.7.1` (used in `helm install`, `helm upgrade`, `--version`)
- Kyverno app version: `v1.17.1` (what runs in the cluster)
- `Chart.yaml` at tag `v1.17.1` confirms: `version: 3.7.1`, `appVersion: v1.17.1`
- The "v2 to v3" breaking change discussion refers to Helm **chart** v2→v3 (which happened around Kyverno app v1.10→v1.13), not a separate "Kyverno v3" product. There is no "Kyverno v3" application — only chart v3.

**2. `subjects`-based matching requires `background: false` in the policy.**
When a ClusterPolicy uses `match.any[].subjects` to scope by ServiceAccount, Kyverno cannot evaluate the policy in background scan mode because subject information is only present in live AdmissionReview requests. Without `background: false`, the policy will apply to background scans and may produce unexpected results or errors.

```yaml
spec:
  background: false   # REQUIRED when using match.any[].subjects
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
```

**3. GKE private clusters require a firewall rule for port 9443.**
Kyverno's admission webhook runs on port 9443. On private GKE clusters, the control plane cannot reach worker nodes on this port by default. Without the firewall rule, the install completes but the webhook is unreachable and policies silently don't apply (or requests time out).

To get the master IP CIDR and create the rule:
```bash
# Get master CIDR
MASTER_CIDR=$(gcloud container clusters describe CLUSTER_NAME \
  --format='value(privateClusterConfig.masterIpv4CidrBlock)' \
  --region=REGION)

# Create firewall rule
gcloud compute firewall-rules create allow-kyverno-webhook \
  --direction=INGRESS \
  --priority=1000 \
  --network=NETWORK_NAME \
  --action=ALLOW \
  --rules=tcp:9443 \
  --source-ranges="${MASTER_CIDR}" \
  --target-tags=CLUSTER_NODE_TAG
```
This applies to **private** GKE clusters. Standard (public) GKE clusters are unaffected.

**4. Helm chart v2 → v3 migration: direct upgrade is NOT supported.**
If the cluster previously had the old Helm chart (v2), a direct `helm upgrade` is blocked. The recommended path is:
1. Backup Kyverno policy resources
2. `helm uninstall kyverno -n kyverno`
3. `helm install kyverno kyverno/kyverno -n kyverno --create-namespace`

For a fresh install (no prior Kyverno), this doesn't apply.

**5. Policy Exceptions default changed (CVE-2024-48921).**
Prior chart versions enabled policy exceptions across all namespaces by default. Chart v3 restricts this. If you need exceptions in all namespaces: `--set features.policyExceptions.namespace=*`. For the demo, this is not needed.

---

### Install Command (single-node demo, non-HA)

```bash
helm repo add kyverno https://kyverno.github.io/kyverno/
helm repo update
helm install kyverno kyverno/kyverno \
  --namespace kyverno \
  --create-namespace \
  --version 3.7.1 \
  --wait \
  --timeout 5m0s
```

- `--version 3.7.1`: pins to the confirmed stable chart (deploys app v1.17.1)
- `--wait`: blocks until all pods are ready (admission controller, background controller, cleanup controller, reports controller)
- `--timeout 5m0s`: generous but bounded; Kyverno typically becomes ready in 1-2 minutes on a healthy cluster with good image pull speed; 5m covers slow image pulls and webhook registration
- No HA replica flags needed for demo; defaults are 1 replica per controller

### Verification after install

```bash
kubectl get pods -n kyverno
kubectl get validatingwebhookconfigurations | grep kyverno
kubectl get mutatingwebhookconfigurations | grep kyverno
```

All four controller pods should be `Running`. The webhook configurations confirm the API server is wired to Kyverno.

---

### Helm Repo and Chart Facts

| Property | Value |
| -------- | ----- |
| Helm repo URL | `https://kyverno.github.io/kyverno/` |
| Chart name | `kyverno/kyverno` |
| Current stable chart version | `3.7.1` |
| Corresponding app version | `v1.17.1` (released Feb 19, 2026) |
| Namespace | `kyverno` |
| Kubernetes compatibility | `>=1.25.0` (chart kubeVersion constraint) |
| K8s 1.31–1.34 support | chart `1.16.x` branch; `1.17.x` targets 1.32–1.35 |

---

### subjects Syntax in ClusterPolicy (v1.16–v1.17)

The syntax is stable across v1.12–v1.17. `subjects` is a **sibling of `resources`** within each element of `match.any[]` or `match.all[]`:

```yaml
spec:
  background: false        # REQUIRED with subjects
  rules:
    - name: my-rule
      match:
        any:
          - resources:
              kinds:
                - Pod
              operations:
                - CREATE
            subjects:           # <-- sibling of resources, same indentation
              - kind: ServiceAccount
                name: my-sa
                namespace: my-namespace
```

**`namespace` in subjects is required** for ServiceAccount kind — without it, the match is ambiguous across namespaces. The PRD's example includes it correctly.

---

### Readiness Timing

- Typical: 1–2 minutes on a healthy cluster with fast image pulls
- Upper bound: 3–4 minutes on slow pulls or during webhook registration retry
- `--timeout 5m0s` in the Helm command is conservative but appropriate for a setup script
- The `webhookRegistrationTimeout` defaults to `120s` — this is Kyverno's own internal retry window, separate from Helm's `--wait`

---

### Caveats

- The GKE firewall rule gotcha affects **private** clusters only. GKE Autopilot and standard public clusters do not have this issue.
- `--wait` depends on liveness/readiness probes passing — confirm the webhook configurations appear after install, not just pod status.
- The `subjects` background-mode restriction means policies using ServiceAccount scoping only fire on live CREATE/UPDATE/DELETE requests. This is fine for the demo use case.
- Background scan policies (no subjects) can audit existing resources. The demo policy doesn't need background scanning.

---

## Sources

- [Kyverno Installation | kyverno.io](https://kyverno.io/docs/installation/installation/) — official Helm repo URL, chart name, install commands
- [Kyverno Installation Methods | kyverno.io](https://kyverno.io/docs/installation/methods/) — HA vs non-HA flags, version pinning guidance
- [Kyverno Chart.yaml at v1.17.1 | GitHub](https://github.com/kyverno/kyverno/blob/v1.17.1/charts/kyverno/Chart.yaml) — authoritative chart version / appVersion mapping (verified via `gh api`)
- [Kyverno GitHub Releases](https://github.com/kyverno/kyverno/releases) — v1.17.1 confirmed as latest stable (Feb 19, 2026); no v3.x application exists
- [Kyverno Upgrading Docs | kyverno.io](https://kyverno.io/docs/installation/upgrading/) — Helm chart v2→v3 migration requirements, CVE-2024-48921 exception change
- [Kyverno Customization / Configuration](https://kyverno.io/docs/installation/customization/) — webhookRegistrationTimeout default (120s), webhookTimeout constraints
- [Kyverno Troubleshooting | kyverno.io](https://kyverno.io/docs/guides/troubleshooting/) — GKE private cluster port 9443 firewall requirement
- [Match/Exclude Policy Docs (v1.16)](https://release-1-16-0.kyverno.io/docs/policy-types/cluster-policy/match-exclude/) — subjects as sibling of resources, background:false requirement
- [Match/Exclude Policy Docs (v1.12)](https://release-1-12-0.kyverno.io/docs/writing-policies/match-exclude/) — subjects background-mode restriction confirmed in older version too
- [GKE + Kyverno setup guide | 8grams.medium.com](https://8grams.medium.com/how-to-setup-kyverno-on-gke-google-kubernetes-cluster-the-right-way-be393219a5) — firewall rule for private GKE clusters
