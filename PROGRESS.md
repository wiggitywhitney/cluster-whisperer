# Progress Log

Development progress log for cluster-whisperer. Tracks implementation milestones across PRD work.

## [Unreleased]

### Added
- Demo app (PRD #46 M1): Hono web server with PostgreSQL connection logic, agent-friendly error messages, health and status endpoints, 9 passing tests
- Demo app (PRD #46 M2): Multi-stage Dockerfile with Node 22 Alpine, verified crash behavior without DATABASE_URL and connection errors with unreachable host
- Demo app (PRD #46 M3): Kubernetes Deployment and Service manifests, DATABASE_URL pointing to non-existent db-service for CrashLoopBackOff demo scenario
- Demo app (PRD #46 M3 verification): Confirmed CrashLoopBackOff behavior in Kind cluster with clear agent-friendly kubectl logs and describe output
- Demo app (PRD #46 M4): E2E agent investigation test — setup/teardown/investigate scripts, CI workflow, verified agent diagnoses missing database in 4-5 tool calls
- Demo app (PRD #46 M4): Investigation flow documentation with expected agent steps, tool calls, and diagnosis path
- Demo app (PRD #46 M5): README documentation — demo app section with structure, build/run instructions, and Kubernetes deployment with real CrashLoopBackOff output
- Demo cluster (PRD #47 M1): Kind cluster creation with dedicated KUBECONFIG, Crossplane Helm install, 148 sub-provider manifests with batched installation, CRD wait with progress indicators
- Demo cluster (PRD #47 M1): setup.sh mode argument (kind/gcp), mode-specific prerequisites, GKE cluster creation, KUBECONFIG isolation for both modes, curated 35-provider Kind subset (20 AWS + 15 GCP), mode-specific CRD targets
- Demo cluster (PRD #47 M6): Teardown script with Kind and GKE cluster discovery/deletion, billing warnings for GKE, KUBECONFIG cleanup
- Demo cluster (PRD #47 decisions): Pivoted to GKE as first-class target — Kind single-node overwhelmed by 150 providers (41 GB RAM). Added `kind|gcp` mode design, curated provider subset for Kind

- Demo cluster (PRD #47 M2): Platform PostgreSQL XRD (apiextensions.crossplane.io/v2) and Composition (Pipeline mode with function-patch-and-transform) — the "needle in the haystack" among ~1,000 CRDs
- Demo cluster (PRD #47 M2): XRD defines PostgreSQLInstance with rich field descriptions (engine, version, storage, HA, backup, network) for inference pipeline discovery
- Demo cluster (PRD #47 M2): Composition maps to AWS RDS Instance with size-to-instance-class transform, Multi-AZ, and subnet group
- Demo cluster (PRD #47 M2): setup.sh integration — installs function-patch-and-transform, applies XRD with CRD registration wait, then Composition
- Demo cluster (PRD #47 M2): 14 manifest validation tests (YAML structure, field descriptions, inference pipeline compatibility)

- (2026-03-11) Demo cluster (PRD #47 M3): Demo app deployment in setup.sh — Kind builds and loads image, GKE pushes to Artifact Registry with deployment patching, CrashLoopBackOff verification, agent-friendly log/describe diagnostics
- (2026-03-11) Demo cluster (PRD #47 M4): Chroma and Qdrant Helm chart deployments with health verification, capability inference pipeline integration via port-forward, instance sync via CLI
- (2026-03-11) Demo cluster (PRD #47 M4): cluster-whisperer Dockerfile for in-cluster serve mode, Kubernetes manifests (Deployment, Service, RBAC), k8s-vectordb-sync controller deployment via Helm
- (2026-03-11) Demo cluster (PRD #47 M5): Jaeger v2 deployment via Helm with OTLP receiver and in-memory storage, OTel Collector (contrib) with fan-out to Jaeger + Datadog, cluster-whisperer serve configured with OTLP export, health check verification for both backends
- (2026-03-11) Demo cluster (PRD #47 M5): Verified end-to-end trace pipeline on live GKE cluster — test trace visible in Jaeger UI, Datadog API key validated and trace agent running

- (2026-03-12) Demo cluster (PRD #47 M7): NGINX Ingress Controller with nip.io wildcard DNS for external access — cluster-whisperer and Jaeger accessible via `<service>.<ip>.nip.io`
- (2026-03-12) Demo cluster (PRD #47 M7): End-to-end setup.sh gcp passes on first try — GKE cluster creation, Crossplane (828+ CRDs), Chroma, Qdrant, Jaeger, OTel Collector, demo app, capability inference (1095 resources), instance sync (1189 instances), cluster-whisperer serve, k8s-vectordb-sync

- (2026-03-12) Demo cluster (PRD #47 M8 prep): `.env.example` documenting required API keys (ANTHROPIC_API_KEY, VOYAGE_API_KEY, DD_API_KEY)
- (2026-03-12) Demo cluster (PRD #47 M8): Validated refactored scripts via full teardown + setup cycle — teardown surgically removed kubeconfig entries, setup completed end-to-end on GKE (1,041 CRDs, all components running, .env auto-loading works)
- (2026-03-12) Demo cluster (PRD #47 M8): README documentation — Demo Cluster section with prerequisites, setup (real output from validated run), component inventory table, capability inference pipeline explanation, and teardown. Updated project structure tree.

- (2026-03-12) Demo modifications (PRD #48 M1): kubectl_apply core tool with catalog validation — parses YAML manifests, validates resource type against capabilities collection via keywordSearch, applies approved resources via kubectl stdin. 32 tests (20 unit + 12 OTel span).
- (2026-03-13) Demo modifications (PRD #48 M1): kubectl-apply integration tests with ephemeral Kind cluster — setup/teardown/run scripts, CI workflow, 4 integration tests (approved apply, catalog rejection, idempotent update, invalid manifest). No API tokens needed.
- (2026-03-13) Demo modifications (PRD #48 M2): kubectl_apply framework wrappers — LangChain tool wrapper with createApplyTools factory (shared VectorStore, graceful degradation), MCP tool registration with catalog validation. Agent investigator wired with all 5 tools. System prompt updated with deployment mode.

### Changed
- (2026-03-12) Demo cluster (PRD #47 M8 prep): Refactored setup.sh kubeconfig handling — export KUBECONFIG after cluster creation, removed ~80 `--kubeconfig` flag occurrences, Kind uses `kind export kubeconfig` for additive merge
- (2026-03-12) Demo cluster (PRD #47 M8 prep): Refactored teardown.sh — surgical removal of per-cluster kubeconfig entries via `kubectl config delete-*` instead of deleting the file
- (2026-03-12) Demo cluster (PRD #47 M8 prep): Removed vals dependency from setup.sh — reads API keys from plain env vars, auto-sources `.env` from repo root if present
- Demo cluster (PRD #47 M1): Unified both modes to use curated 35-provider subset (~1,000 CRDs), down from 148 providers (1,900 CRDs). Deleted batch-1 through batch-5 manifests.
- Demo cluster (PRD #47 M1): Switched to n2-standard-4 machine type (n1 hit GCE_STOCKOUT), zonal clusters (regional exceeded CPU quota), zone auto-detection via ipinfo.io timezone
- Demo cluster (PRD #47 M1): Reduced Crossplane memory 4Gi → 2Gi, increased CRD wait timeout 10min → 20min for cold image pulls
- Demo cluster (PRD #47 M1): Verified clean GKE run — 1,040 CRDs, all 37 providers healthy, Crossplane stable at 618Mi/2Gi

### Fixed
- (2026-03-12) Demo cluster (PRD #47 M7): Eliminated double-rollout for GKE deployments — sed inline image replacement instead of apply+patch, avoiding ImagePullBackOff delay
- (2026-03-12) Demo cluster (PRD #47 M7): Fixed helm search repo fallback — `helm search repo` returns exit 0 with "No results found", now checks stdout for actual matches
- (2026-03-12) Demo cluster (PRD #47 M7): Fixed health checks for Chroma (v2 API, StatefulSet target), OTel Collector (0.0.0.0 bind), all using port-forward + local curl
- (2026-03-12) Demo cluster (PRD #47 M7): Increased k8s-vectordb-sync memory from 128Mi to 1Gi (OOMKilled watching 1000+ CRDs)
- (2026-03-12) Demo cluster (PRD #47 M7): Architecture-aware Dockerfile kubectl download (arm64 vs amd64), `--platform linux/amd64` for GKE builds
