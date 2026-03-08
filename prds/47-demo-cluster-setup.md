# PRD #47: Demo Cluster Setup and Teardown Scripts

**Status**: Not Started
**Priority**: High
**Dependencies**: PRD #46 (demo app)
**Branch**: `feature/prd-47-demo-cluster-setup`

## Problem

The KubeCon "Choose Your Own Adventure" demo requires a reproducible Kubernetes
environment with many moving parts: Crossplane with 1,200+ CRDs, two vector databases,
two observability backends, a broken demo app, and a sync controller. Setting this up
manually before each demo rehearsal or the actual talk is error-prone and slow.

The demo cluster must be creatable and destroyable with a single script so that Whitney
can practice the demo repeatedly and recover quickly if something goes wrong on stage.

## Solution

Create setup and teardown scripts in `demo/cluster/` that provision a complete Kind
cluster with all demo components. The setup script should be idempotent and the teardown
script should cleanly destroy everything.

A key element: install monolithic Crossplane providers (`provider-aws` + `provider-gcp`)
to register 1,200+ CRDs without cloud credentials. Then define one Crossplane
Composition/XRD as the platform team's approved PostgreSQL database — the "needle in
the haystack" that the agent finds via semantic search.

## Success Criteria

- `./demo/cluster/setup.sh` creates a complete demo environment from scratch
- `./demo/cluster/teardown.sh` destroys the Kind cluster cleanly
- After setup, the demo app is in CrashLoopBackOff (missing database)
- After setup, both Chroma and Qdrant are running and populated with CRD capabilities
- After setup, both Jaeger and Datadog Agent are receiving traces
- `kubectl get crds | wc -l` shows 1,200+ CRDs
- The Crossplane Composition for PostgreSQL is discoverable via vector search
- The cluster can be fully set up within a reasonable time (target: under 15 minutes, accepting that CRD registration is slow)
- Setup script is idempotent — running it twice doesn't break anything

## Non-Goals

- Cloud credentials or actual cloud resource provisioning
- Production cluster hardening
- Multi-node Kind clusters
- CI/CD integration (this is for local development and demo rehearsal)

## Milestones

### M1: Kind Cluster and Crossplane
- [ ] Kind cluster creation with appropriate config (port mappings, etc.)
- [ ] Crossplane installation via Helm
- [ ] `provider-aws` and `provider-gcp` installation (monolithic, no credentials)
- [ ] Wait for CRD registration (1,200+ CRDs available)
- [ ] Progress indicators during slow CRD registration phase

### M2: Platform Composition (The Right Answer)
- [ ] Crossplane CompositeResourceDefinition (XRD) for the platform's approved PostgreSQL database
- [ ] Crossplane Composition implementing the XRD
- [ ] The Composition should be the "one right answer" that the agent finds among 1,200+ CRDs
- [ ] The XRD/Composition must produce rich enough metadata for the capability inference pipeline to generate a meaningful description
- [ ] Verified: after capability inference, the vector DB can find this resource via "PostgreSQL database for my application"

### M3: Demo App Deployment
- [ ] Deploy demo app from PRD #46 into the cluster
- [ ] Verify CrashLoopBackOff status (DATABASE_URL points to nonexistent service)
- [ ] Verify `kubectl logs` and `kubectl describe` output is agent-friendly

### M4: Vector Databases
- [ ] Chroma deployment via Helm
- [ ] Qdrant deployment via Helm
- [ ] Both accessible from within the cluster
- [ ] Run capability inference pipeline against both backends (populate capabilities collection)
- [ ] Deploy k8s-vectordb-sync controller, verify instance sync to both backends

### M5: Observability Backends
- [ ] Jaeger deployment via Helm with OTLP receiver
- [ ] Datadog Agent deployment via Helm with OTLP receiver (port 4318)
- [ ] Both receiving traces from cluster-whisperer
- [ ] Verified: run a cluster-whisperer query, see trace in both backends

### M6: Teardown Script
- [ ] `teardown.sh` destroys the Kind cluster
- [ ] Clean removal of all Docker resources associated with the cluster

### M7: End-to-End Demo Rehearsal
- [ ] Run setup script from scratch
- [ ] Execute the full demo flow (all 4 acts) against the cluster
- [ ] Run teardown script
- [ ] Run setup script again to verify reproducibility

### M8: Documentation
- [ ] Update README using `/write-docs` to document the demo cluster setup/teardown

## Technical Design

### Directory Structure

```text
demo/cluster/
├── setup.sh              # Main setup script
├── teardown.sh           # Cluster destruction
├── kind-config.yaml      # Kind cluster configuration
├── helm-values/
│   ├── crossplane.yaml   # Crossplane Helm values
│   ├── chroma.yaml       # Chroma Helm values
│   ├── qdrant.yaml       # Qdrant Helm values
│   ├── jaeger.yaml       # Jaeger Helm values
│   └── datadog.yaml      # Datadog Agent Helm values
└── manifests/
    ├── crossplane-providers.yaml  # Provider installations
    ├── composition.yaml           # Platform PostgreSQL Composition
    └── xrd.yaml                   # CompositeResourceDefinition
```

### Setup Script Flow

1. Create Kind cluster (with port mappings for observability UIs)
2. Install Crossplane via Helm
3. Install Crossplane providers (provider-aws, provider-gcp) — wait for CRD registration
4. Apply platform Composition/XRD
5. Deploy Chroma and Qdrant via Helm
6. Deploy Jaeger and Datadog Agent via Helm
7. Deploy demo app
8. Deploy k8s-vectordb-sync controller
9. Start cluster-whisperer serve (background, to receive sync data)
10. Run capability inference pipeline against both vector backends
11. Wait for instance sync to complete
12. Print summary: component statuses, URLs for observability UIs

### Crossplane Providers Without Credentials

Installing `provider-aws` and `provider-gcp` registers all CRDs without a
ProviderConfig. The provider pods will be in a degraded state (can't reconcile),
but the CRDs are fully registered and discoverable. This is intentional — the
demo only needs the CRDs to exist for discovery, not to provision cloud resources.

### The "Needle in the Haystack"

The Crossplane Composition defines a platform-approved PostgreSQL database. The
capability inference pipeline will analyze the XRD and generate a description like:
"Platform-approved PostgreSQL database for application teams. Provides managed
PostgreSQL with standard configuration." This description is what the agent finds
when searching for "PostgreSQL database for my application."

The 1,200+ CRDs from provider-aws and provider-gcp are the noise. The XRD is the signal.

### Timing Expectations

- Kind cluster creation: ~30 seconds
- Crossplane install: ~1 minute
- CRD registration (provider-aws + provider-gcp): ~5-10 minutes (the slow part)
- Helm charts (Chroma, Qdrant, Jaeger, Datadog): ~2 minutes each
- Capability inference pipeline: ~2-3 minutes (LLM calls for 1,200+ CRDs)
- Instance sync: ~1-2 minutes

Total: approximately 15-20 minutes. The setup script should show progress throughout.

## Decision Log

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-03-07 | Monolithic providers over provider families | Maximizes CRD count for the "overwhelming" demo moment. Provider families would install fewer, more targeted CRDs. |
| 2026-03-07 | No cloud credentials | Demo only needs CRDs for discovery, not actual provisioning. Simplifies setup. |
| 2026-03-07 | Both vector DBs pre-populated | Avoids live population during demo. CLI flag switches backend. |
| 2026-03-07 | Both observability backends receiving simultaneously | OTLP exports to both. Vote just changes which UI to open. |
