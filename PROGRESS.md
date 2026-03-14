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
- Demo cluster (PRD #47 M2): XRD defines ManagedService with rich field descriptions (engine, version, storage, HA, backup, network) for inference pipeline discovery
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
- (2026-03-13) Demo modifications (PRD #48 M3): --tools CLI flag with tool-group filtering — parseToolGroups module (kubectl, vector, apply groups), getInvestigatorAgent accepts toolGroups option, default kubectl,vector for backwards compatibility. 14 new tests (9 parsing + 5 agent filtering).
- (2026-03-13) Demo modifications (PRD #48 M4): --agent CLI flag with agent factory — AgentType parsing (langgraph/vercel), createAgent factory routing to LangGraph or "not yet implemented" for Vercel, CLI wired through factory. 12 new tests (8 parsing + 4 factory routing). Plumbing ready for PRD #49.
- (2026-03-13) Demo modifications (PRD #48 M5): QdrantBackend implementing VectorStore interface — filter syntax translation (Chroma flat key-value → Qdrant must conditions), keywordSearch via scroll, search via query API, OTel spans matching ChromaBackend patterns. 32 unit tests + 8 integration tests. @qdrant/js-client-rest dependency added.
- (2026-03-13) Demo modifications (PRD #48 M6): --vector-backend CLI flag with backend factory — parseVectorBackend module (chroma/qdrant), createVectorStore factory routing to ChromaBackend or QdrantBackend, --qdrant-url flag on all subcommands, vectorBackend wired through agent-factory to investigator. 14 new tests (8 parsing + 6 factory routing).
- (2026-03-13) Demo modifications (PRD #48 M6): Cross-backend equivalence integration tests — verifies both Chroma and Qdrant produce identical semantic search, metadata filter, and combined search results when populated with the same data. 7 integration tests (skip gracefully without infrastructure).
- (2026-03-13) Demo modifications (PRD #48 M7): Verified OTel instrumentation for QdrantBackend — spans already implemented in M5 covering initialize, store, search, keywordSearch, delete. 32 OTel span tests verify db.system:"qdrant", db.operation.name, db.collection.name, custom count attributes, error recording, no-op tracer behavior.
- (2026-03-13) Demo modifications (PRD #48 M8): Env var support for all CLI flags — Commander.js `.addOption(new Option(...).env(...))` on all subcommands for CLUSTER_WHISPERER_AGENT, CLUSTER_WHISPERER_TOOLS, CLUSTER_WHISPERER_VECTOR_BACKEND, CLUSTER_WHISPERER_CHROMA_URL, CLUSTER_WHISPERER_QDRANT_URL
- (2026-03-13) Demo modifications (PRD #48 M8): Kubeconfig pass-through — CLUSTER_WHISPERER_KUBECONFIG env var threaded through CLI → agent-factory → investigator → createKubectlTools/createApplyTools → executeKubectl/spawnSync. KubectlOptions interface, createKubectlTools factory replacing static kubectlTools array. 7 new kubeconfig tests.
- (2026-03-13) Demo modifications (PRD #48 M8): Infrastructure ingress rules — Chroma, Qdrant, and OTel Collector ingress via nip.io in setup.sh. Demo `.env` generation with resolved infrastructure URLs (KUBECONFIG, vector DB URLs, OTel endpoint). Serve manifest updated with `--qdrant-url`.
- (2026-03-13) Demo modifications (PRD #48 M7/M8): Verified all 3 M8 verification items on live GKE cluster — kubeconfig governance (kubectl fails, agent succeeds), traces in Jaeger (64 spans via OTel Collector ingress), Qdrant traces (7 spans with db.system:"qdrant" attributes) in Jaeger

- (2026-03-13) Demo modifications (PRD #48 M9): MultiBackendVectorStore — VectorStore wrapper that writes to all backends in parallel via Promise.all, reads from first backend. 15 unit tests. Sync commands auto-detect multi-backend mode when both Chroma and Qdrant URLs provided. Setup script updated for dual-backend sync and verification.
- (2026-03-13) Demo modifications (PRD #48 M9): Qdrant UUID v5 ID mapping — deterministic string-to-UUID conversion for Qdrant point IDs (rejects arbitrary strings). Original IDs stored in payload as `_originalId` for transparent retrieval. 11 new tests (UUID format, determinism, store/search/delete round-trip).
- (2026-03-13) Demo modifications (PRD #48 M9): Inference cache — file-based cache for LLM inference results keyed by SHA-256 of resource name + schema. Automatic invalidation on schema changes, incremental saves after each resource, `--no-cache` CLI flag. 18 unit tests. Prevents re-running ~30 min of Haiku calls when storage fails.
- (2026-03-13) Demo modifications (PRD #48 M9): Verified multi-backend sync on live GKE cluster — single sync invocation populates both Chroma and Qdrant with identical document counts (capabilities: 1083/1083, instances: 1210/1210). Ingress proxy-body-size increased to 10m for batch upserts.

- (2026-03-14) Demo modifications (PRD #48 M10): Full demo rehearsal on live GKE cluster — teardown + setup.sh gcp exit 0 from scratch (1041 CRDs, all services running), all 4 demo acts verified (kubectl governance, CRD wall, vector search with both Chroma and Qdrant, ManagedService deploy), traces confirmed in Jaeger (25 spans with tool/LLM/workflow spans)

- (2026-03-14) Demo modifications (PRD #48 M12): 19 decoy ManagedService XRDs with Compositions — each for a different fake team/person/app (payments, hr, analytics, etc.), structurally similar to the real one but with subtle flaws (wrong engine, port, instance class, network ref). All 20 applied by setup.sh.
- (2026-03-14) Demo modifications (PRD #48 M12): Generic demo app error messages — removed postgres:// from DATABASE_URL, changed error to "backend service" so agent must use semantic search to discover the service type
- (2026-03-14) Demo modifications (PRD #48 M12): Verified 20 ManagedService CRDs registered on live cluster, both vector DBs synced at 1102 capabilities (1083 original + 19 decoys)
- (2026-03-14) Demo modifications (PRD #48 M12): Chroma $and filter fix — normalizeWhereFilter wraps multi-key where filters in $and for Chroma compatibility (Qdrant already handled this via buildFilter)
- (2026-03-14) Demo modifications (PRD #48 M12): Updated investigator prompt and vector_search tool description to ask follow-up questions when multiple similar results appear (team name, app name, person)

### Changed
- (2026-03-14) Demo modifications (PRD #48 M12): Updated main XRD description to mention Whitney/Viktor and You Choose demo app — organizational context only discoverable via vector search among 20 identical-looking ManagedService CRDs
- (2026-03-14) Demo modifications (PRD #48 M12): Investigator prompt now instructs agent to fall back to `kubectl get crd` for discovery when vector_search is unavailable, and to ask clarifying questions when results are ambiguous
- (2026-03-13) Demo modifications (PRD #48): Renamed platform XRD from `postgresqlinstances.platform.cluster-whisperer.io` to `managedservices.platform.acme.io` — opaque name forces agent to use vector search instead of CRD name scanning
- (2026-03-13) Demo modifications (PRD #48): Updated demo flow with two-question Act 2 (investigation + CRD wall follow-up), restructured PRD milestones (added M9 multi-backend sync, M10 full rehearsal)
- (2026-03-12) Demo cluster (PRD #47 M8 prep): Refactored setup.sh kubeconfig handling — export KUBECONFIG after cluster creation, removed ~80 `--kubeconfig` flag occurrences, Kind uses `kind export kubeconfig` for additive merge
- (2026-03-12) Demo cluster (PRD #47 M8 prep): Refactored teardown.sh — surgical removal of per-cluster kubeconfig entries via `kubectl config delete-*` instead of deleting the file
- (2026-03-12) Demo cluster (PRD #47 M8 prep): Removed vals dependency from setup.sh — reads API keys from plain env vars, auto-sources `.env` from repo root if present
- Demo cluster (PRD #47 M1): Unified both modes to use curated 35-provider subset (~1,000 CRDs), down from 148 providers (1,900 CRDs). Deleted batch-1 through batch-5 manifests.
- Demo cluster (PRD #47 M1): Switched to n2-standard-4 machine type (n1 hit GCE_STOCKOUT), zonal clusters (regional exceeded CPU quota), zone auto-detection via ipinfo.io timezone
- Demo cluster (PRD #47 M1): Reduced Crossplane memory 4Gi → 2Gi, increased CRD wait timeout 10min → 20min for cold image pulls
- Demo cluster (PRD #47 M1): Verified clean GKE run — 1,040 CRDs, all 37 providers healthy, Crossplane stable at 618Mi/2Gi

### Fixed
- (2026-03-14) Demo modifications (PRD #48 M10): QdrantBackend `collectionExists` returned `{ exists: boolean }` not `boolean` — destructuring fix prevents silent collection creation failure
- (2026-03-14) Demo modifications (PRD #48 M10): Backend constructors now read `CLUSTER_WHISPERER_CHROMA_URL`/`CLUSTER_WHISPERER_QDRANT_URL` env vars — agent connects to ingress URLs when running locally against remote cluster
- (2026-03-14) Demo modifications (PRD #48 M10): Generated `demo/.env` now includes `OTEL_TRACING_ENABLED=true` and `OTEL_EXPORTER_TYPE=otlp` — tracing was silently disabled without these
- (2026-03-13) Demo modifications (PRD #48 M9): Qdrant rejects string point IDs with "Bad Request" — added UUID v5 conversion so document IDs like "configmaps" become deterministic UUIDs
- (2026-03-13) Demo modifications (PRD #48 M9): Setup script sync commands strip ANTHROPIC_BASE_URL and ANTHROPIC_CUSTOM_HEADERS so Haiku inference calls bypass Datadog AI Gateway
- (2026-03-13) Demo modifications (PRD #48 M8): URL port parsing in ChromaBackend and QdrantBackend — ingress URLs (port 80) incorrectly defaulted to service ports (8000/6333). Now uses protocol defaults (80/443) when no explicit port
- (2026-03-13) Demo modifications (PRD #48 M8): Vector tool error message hardcoded "Chroma server" even when using Qdrant backend — now backend-agnostic
- (2026-03-12) Demo cluster (PRD #47 M7): Eliminated double-rollout for GKE deployments — sed inline image replacement instead of apply+patch, avoiding ImagePullBackOff delay
- (2026-03-12) Demo cluster (PRD #47 M7): Fixed helm search repo fallback — `helm search repo` returns exit 0 with "No results found", now checks stdout for actual matches
- (2026-03-12) Demo cluster (PRD #47 M7): Fixed health checks for Chroma (v2 API, StatefulSet target), OTel Collector (0.0.0.0 bind), all using port-forward + local curl
- (2026-03-12) Demo cluster (PRD #47 M7): Increased k8s-vectordb-sync memory from 128Mi to 1Gi (OOMKilled watching 1000+ CRDs)
- (2026-03-12) Demo cluster (PRD #47 M7): Architecture-aware Dockerfile kubectl download (arm64 vs amd64), `--platform linux/amd64` for GKE builds
