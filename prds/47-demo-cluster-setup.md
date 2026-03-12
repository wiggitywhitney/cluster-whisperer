# PRD #47: Demo Cluster Setup and Teardown Scripts

**Status**: In Progress
**Priority**: High
**Dependencies**: PRD #46 (demo app)
**Execution Order**: 3 of 5 — Needs the demo app. Provides the test environment for PRDs #48 and #49.
**Branch**: `feature/prd-47-demo-cluster-setup`

## Problem

The KubeCon "Choose Your Own Adventure" demo requires a reproducible Kubernetes
environment with many moving parts: Crossplane with 1,200+ CRDs, two vector databases,
two observability backends, a broken demo app, and a sync controller. Setting this up
manually before each demo rehearsal or the actual talk is error-prone and slow.

The demo cluster must be creatable and destroyable with a single script so that Whitney
can practice the demo repeatedly and recover quickly if something goes wrong on stage.

## Solution

Create setup and teardown scripts in `demo/cluster/` that provision a Kubernetes cluster
with all demo components. The setup script accepts a mode argument (`kind` or `gcp`) to
target either a local Kind cluster or a GKE cluster. GKE is the first-class target for
rehearsals and the live demo; Kind is a lightweight fallback for quick local iteration.

The setup script should be idempotent and the teardown script should cleanly destroy
everything (including GKE clusters to avoid billing surprises).

A key element: install a curated subset of 35 Crossplane sub-providers (20 AWS + 15 GCP)
to register ~1,000 CRDs without cloud credentials (Decision 15). Both Kind and GKE modes
use the same subset — enough to feel overwhelming without being wasteful.
Then define one Crossplane Composition/XRD as the platform team's approved PostgreSQL
database — the "needle in the haystack" that the agent finds via semantic search.

## Success Criteria

- `./demo/cluster/setup.sh gcp` creates a complete demo environment on GKE
- `./demo/cluster/setup.sh kind` creates a lightweight local environment for iteration
- `./demo/cluster/teardown.sh` destroys all cluster-whisperer clusters (Kind and GKE)
- After setup, `kubectl get crds | wc -l` shows ~1,000 CRDs (Decision 15)
- After setup, the demo app is in CrashLoopBackOff (missing database)
- After setup, both Chroma and Qdrant are running and populated with CRD capabilities
- After setup, both Jaeger and OTel Collector (with Datadog exporter) are receiving traces
- The Crossplane Composition for PostgreSQL is discoverable via vector search
- Setup script is idempotent — running it twice doesn't break anything
- KUBECONFIG isolation works for both modes (dedicated `~/.kube/config-cluster-whisperer`)

## Non-Goals

- Actual cloud resource provisioning via Crossplane (CRDs exist for discovery only)
- Production cluster hardening
- Multi-node Kind clusters
- CI/CD integration (this is for local development and demo rehearsal)

## Milestones

### M1: Cluster Creation and Crossplane (GKE + Kind)
- [x] `setup.sh` accepts mode argument: `kind` or `gcp` (Decision 9)
- [x] Kind cluster creation with port mappings (Jaeger UI, OTLP receivers)
- [x] GKE cluster creation (`demoo-ooclock`, zonal auto-detect, `n2-standard-4`, 3 nodes) (Decisions 10, 13, 14)
- [x] Separate prerequisites checks per mode: Kind (kind, docker) vs GCP (gcloud, gke-gcloud-auth-plugin) (Decision 9)
- [x] KUBECONFIG isolation for Kind — dedicated `~/.kube/config-cluster-whisperer`
- [x] KUBECONFIG isolation for GKE — set `KUBECONFIG` env var before `gcloud get-credentials` (Decision 11)
- [x] Crossplane installation via Helm
- [x] Curated 35 sub-provider manifest (20 AWS + 15 GCP) for both modes (Decisions 12, 15)
- [x] Wait for CRD registration with progress indicators
- [x] GKE: ~1,000 CRDs verified (Decision 15)

### M2: Platform Composition (The Right Answer)
- [x] Crossplane CompositeResourceDefinition (XRD) for the platform's approved PostgreSQL database
- [x] Crossplane Composition implementing the XRD
- [x] The Composition should be the "one right answer" that the agent finds among ~1,000 CRDs
- [x] The XRD/Composition must produce rich enough metadata for the capability inference pipeline to generate a meaningful description

### M3: Demo App Deployment
- [x] Deploy demo app from PRD #46 into the cluster
- [x] Verify CrashLoopBackOff status (DATABASE_URL points to nonexistent service)
- [x] Verify `kubectl logs` and `kubectl describe` output is agent-friendly

### M4: Vector Databases
- [x] Chroma deployment via Helm
- [x] Qdrant deployment via Helm
- [x] Both accessible from within the cluster
- [x] Run capability inference pipeline against both backends (populate capabilities collection)
- [x] Verified: vector DB can find the platform PostgreSQL XRD via "PostgreSQL database for my application"
- [x] Deploy k8s-vectordb-sync controller, verify instance sync to both backends

### M5: Observability Backends
- [x] Jaeger deployment via Helm with OTLP receiver
- [x] OTel Collector (contrib) deployment with Datadog exporter — receives OTLP in-cluster, exports to datadoghq.com using DD_API_KEY from vals
- [x] Both receiving traces from cluster-whisperer
- [x] Verified: run a cluster-whisperer query, see trace in both backends

### M6: Teardown Script
- [x] `teardown.sh` discovers and destroys Kind clusters (prefix pattern match)
- [x] `teardown.sh` discovers and destroys GKE clusters (`gcloud container clusters list --filter`) (Decision 9)
- [x] Clean removal of dedicated KUBECONFIG file
- [x] Warn about running GKE clusters and associated billing

### M7: End-to-End Demo Rehearsal
- [x] Run setup script from scratch
- [ ] ~~Execute the full demo flow (all 4 acts) against the cluster~~ — Deferred: blocked on PRDs #48/#49; will validate as part of those PRDs
- [x] Run teardown script
- [x] Run setup script again to verify reproducibility

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
│   └── otel-collector.yaml  # OTel Collector Helm values (Datadog exporter)
└── manifests/
    ├── crossplane-providers-batch-0.yaml  # Family providers (installed first)
    ├── crossplane-providers-kind.yaml     # Curated 35 sub-providers (both modes)
    ├── composition.yaml                   # Platform PostgreSQL Composition
    └── xrd.yaml                           # CompositeResourceDefinition
```

### Setup Script Flow

Usage: `./demo/cluster/setup.sh [kind|gcp]`

1. Check prerequisites (mode-specific: Kind needs docker/kind, GCP needs gcloud/gke-gcloud-auth-plugin)
2. Create cluster (Kind with port mappings, or GKE zonal with 3× n2-standard-4 nodes)
3. Write dedicated KUBECONFIG (`~/.kube/config-cluster-whisperer`)
4. Install Crossplane via Helm (2Gi memory limit for core pod)
5. Install Crossplane providers — curated 35 sub-providers — wait for CRD registration (~1,000 CRDs)
6. Apply platform Composition/XRD
7. Deploy Chroma and Qdrant via Helm
8. Deploy Jaeger and OTel Collector (with Datadog exporter) via Helm
9. Deploy demo app
10. Deploy k8s-vectordb-sync controller
11. Start cluster-whisperer serve (background, to receive sync data)
12. Run capability inference pipeline against both vector backends
13. Wait for instance sync to complete
14. Print summary: component statuses, URLs for observability UIs

### KUBECONFIG Isolation

The setup script uses a dedicated kubeconfig file (`~/.kube/config-cluster-whisperer`)
to avoid polluting the default `~/.kube/config`. Both modes write to this file:
- **Kind**: `kind get kubeconfig` output is copied (not symlinked) to the dedicated file
- **GKE**: `KUBECONFIG=~/.kube/config-cluster-whisperer` is set before
  `gcloud container clusters get-credentials`, directing gcloud to write there

All subsequent kubectl commands use `--kubeconfig` or the `KUBECONFIG` env var.
The teardown script removes this file.

Cluster names are timestamped (`cluster-whisperer-YYYYMMDD-HHMMSS`) to prevent
collisions when creating/destroying clusters repeatedly during demo rehearsal.

### Crossplane Providers Without Credentials

A curated subset of 35 sub-providers (20 AWS + 15 GCP) registers ~1,000 CRDs without
a ProviderConfig (Decision 15). The provider pods will be in a degraded state (can't
reconcile), but the CRDs are fully registered and discoverable. This is intentional —
the demo only needs the CRDs to exist for discovery, not to provision cloud resources.

Sub-providers depend on their family providers (`provider-family-aws`,
`provider-family-gcp`) for shared ProviderConfig handling. Family providers must be
installed first, then sub-providers are applied in a second batch.

Both Kind and GKE modes use the same curated subset.

### The "Needle in the Haystack"

The Crossplane Composition defines a platform-approved PostgreSQL database. The
capability inference pipeline will analyze the XRD and generate a description like:
"Platform-approved PostgreSQL database for application teams. Provides managed
PostgreSQL with standard configuration." This description is what the agent finds
when searching for "PostgreSQL database for my application."

The ~1,000 CRDs from provider-aws and provider-gcp are the noise. The XRD is the signal.

### Timing Expectations

**GKE mode** (first-class target):
- GKE cluster creation: ~7-10 minutes
- NGINX Ingress Controller + LoadBalancer IP: ~2 minutes
- Crossplane install: ~1 minute
- CRD registration (35 sub-providers): ~20-25 minutes (cold start with 37 image pulls)
- Helm charts (Chroma, Qdrant, Jaeger, OTel Collector): ~1-2 minutes each
- Capability inference pipeline: ~10-15 minutes (LLM calls for ~1,100 resources)
- Instance sync: ~2-3 minutes
- cluster-whisperer serve + k8s-vectordb-sync: ~2-3 minutes
- Total: approximately 45-55 minutes

**Kind mode** (lightweight fallback):
- Kind cluster creation: ~30 seconds
- Crossplane install: ~1 minute
- CRD registration (same 35 sub-providers): ~5-10 minutes
- Remaining phases: same as GKE
- Total: approximately 15-20 minutes

The setup script shows progress throughout. CRD wait timeout is 20 minutes to
accommodate cold starts where all 37 container images (2 family + 35 sub-provider)
must be pulled.

## Decision Log

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-03-07 | ~~Monolithic providers over provider families~~ (superseded by Decision 14: individual sub-providers) | Original: maximize CRD count. Monolithic packages since removed from Upbound registry. |
| 2026-03-07 | No cloud credentials | Demo only needs CRDs for discovery, not actual provisioning. Simplifies setup. |
| 2026-03-07 | Both vector DBs pre-populated | Avoids live population during demo. CLI flag switches backend. |
| 2026-03-07 | Both observability backends receiving simultaneously | OTLP exports to both. Vote just changes which UI to open. |
| 2026-03-08 | OTel Collector (contrib) instead of Datadog Agent | Only need OTLP receiver → Datadog exporter. Matches kubecon-2026-gitops pattern. Lighter than full Datadog Agent. |
| 2026-03-08 | In-cluster OTel Collector, not host-level Datadog Agent | Host-level agent is Enterprise IT's corporate dogfood agent — wrong org, not reproducible. In-cluster collector is self-contained, uses demo DD_API_KEY from vals, created/destroyed with the cluster. |
| 2026-03-08 | Dedicated KUBECONFIG file (`~/.kube/config-cluster-whisperer`) | Avoids polluting default kubeconfig with Kind entries. Copy (not symlink) after cluster creation. Teardown removes it. Matches spider-rainbows pattern. |
| 2026-03-08 | Timestamped cluster names (`cluster-whisperer-YYYYMMDD-HHMMSS`) | Prevents naming collisions when creating/tearing down repeatedly. Matches spider-rainbows and kubecon-2026-gitops patterns. |
| 2026-03-08 | GKE as first-class target, Kind as lightweight fallback | 150 provider pods overwhelm Kind (41 GB RAM, 1000%+ CPU, API server unresponsive). GKE handles this easily with real node resources. GKE is the rehearsal and live demo target. |
| 2026-03-08 | `./setup.sh [kind\|gcp]` mode argument | Matches spider-rainbows and kubecon-2026-gitops pattern. Unified script with mode-specific functions for cluster creation, prerequisites, and provider count. |
| 2026-03-08 | GCP config: `demoo-ooclock`, auto-detect zone, `n2-standard-4`, 3 nodes (Decisions 13-15 updated this) | Same project as spider-rainbows and kubecon-2026-gitops. 3 zonal nodes for 35 provider pods. |
| 2026-03-08 | KUBECONFIG isolation for both modes | Kind: copy kubeconfig. GKE: set `KUBECONFIG` env var before `gcloud get-credentials`. Both write to `~/.kube/config-cluster-whisperer`. |
| 2026-03-08 | Kind uses curated ~30-40 sub-provider subset | All 148 sub-providers overwhelm Kind single-node cluster. Curated subset gives ~400-600 CRDs — enough for semantic search testing without killing the API server. |
| 2026-03-08 | Individual sub-providers, not monolithic packages | Monolithic `provider-aws`/`provider-gcp` deprecated and removed from Upbound registry. Must use individual sub-providers with family providers as dependencies. |
| 2026-03-11 | n2-standard-4 machine type over n1-standard-4 | n1 is first-gen (Skylake/Broadwell), hit GCE_STOCKOUT in multiple zones. n2 (Cascade Lake) has better availability, 20% performance improvement, same price class. |
| 2026-03-11 | Zonal cluster over regional cluster | Regional creates nodes × 3 zones (3 nodes × 3 = 9 = 36 CPUs, exceeds 32 CPU quota). Zonal gives exact node count. Demo doesn't need HA. |
| 2026-03-11 | Curated 35 sub-providers for both modes (down from 148) | 1,900 CRDs was overkill — needed 4Gi memory, 90+ min registration, fragile. 35 providers give ~1,000 CRDs: still overwhelming for the demo narrative but needs only 2Gi memory, registers in ~15 min, and is more reliable. |
| 2026-03-11 | Zone auto-detection via ipinfo.io timezone | Demo will be presented at KubeCon in Europe. Scripts must work in any region. `curl ipinfo.io/timezone` maps to nearest GCP zone. Override with `GCP_ZONE` env var. |
| 2026-03-11 | Capability inference populates Chroma only; Qdrant deferred to PRD #48 | No QdrantBackend implementation exists yet (only ChromaBackend). PRD #48 M2 implements the Qdrant backend and populates it. Both vector DBs are deployed and ready; only population differs. |
| 2026-03-11 | cluster-whisperer serve deployed in-cluster via Dockerfile | Created Dockerfile for cluster-whisperer. The serve pod runs in-cluster so k8s-vectordb-sync can push resource changes. Kind loads the image locally; GKE pushes to Artifact Registry. |
| 2026-03-11 | OTel Collector as trace fan-out hub | cluster-whisperer → OTel Collector → {Jaeger, Datadog}. Single OTLP endpoint for the app; collector handles routing to both backends. Avoids dual-export complexity in the app. Jaeger v2 with in-memory storage for demo. |
| 2026-03-11 | Jaeger v2 (not v1) | Jaeger v1 EOL Dec 2025. v2 uses OTel Collector config syntax natively. OTLP receiver is built-in (no env var toggle needed). All-in-one mode with memory storage for demo use. |
| 2026-03-12 | Health checks via port-forward + local curl (not kubectl exec) | Container images (Chroma, Qdrant, OTel Collector) don't include wget/curl. Jaeger happened to have wget, masking the problem. Port-forward to unique local ports avoids dependency on container tooling. |
| 2026-03-12 | Chroma v2 API (`/api/v2/heartbeat`) | Chroma v1.5.3 deprecated the v1 API; `/api/v1/heartbeat` returns 410 Gone. Must use `/api/v2/heartbeat`. |
| 2026-03-12 | OTel Collector health check binds to `0.0.0.0:13133` | Helm chart default binds to `${env:MY_POD_IP}`, which breaks port-forward (connects to localhost, nothing listening). Explicit `0.0.0.0` in values override. |
| 2026-03-12 | Inline image replacement for GKE (no apply+patch double-rollout) | Applying base manifest with `imagePullPolicy: Never` on GKE creates a pod in ImagePullBackOff, then patching triggers a second rollout. Piping through `sed` sets the correct AR image and `IfNotPresent` before applying. |
| 2026-03-12 | k8s-vectordb-sync needs 1Gi memory for large CRD clusters | Controller watches 1000+ API resources and caches informer metadata. 128Mi and 512Mi both OOMKill. 1Gi is sufficient for ~830 CRDs. |
| 2026-03-12 | NGINX Ingress Controller + nip.io for external access | Single LoadBalancer routes to all services via host-based ingress rules. `<service>.<external-ip>.nip.io` provides DNS without registration. Pattern borrowed from spider-rainbows repo. |
| 2026-03-12 | CRD timeout 1800s with transient failure tolerance | Cold starts pull ~37 container images. 1800s (30 min) timeout. `|| crd_count=0` fallback prevents pipefail from killing the script on transient API server errors. |
| 2026-03-12 | Defer "full demo flow" validation to PRDs #48/#49 | The 4-act demo flow requires PRD #48 (demo modifications) and PRD #49 (Vercel agent), which aren't implemented yet. Setup/teardown scripts are proven reliable; demo flow validation belongs in the PRDs that implement the flow. |
