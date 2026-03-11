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

### Changed
- Demo cluster (PRD #47 M1): Unified both modes to use curated 35-provider subset (~1,000 CRDs), down from 148 providers (1,900 CRDs). Deleted batch-1 through batch-5 manifests.
- Demo cluster (PRD #47 M1): Switched to n2-standard-4 machine type (n1 hit GCE_STOCKOUT), zonal clusters (regional exceeded CPU quota), zone auto-detection via ipinfo.io timezone
- Demo cluster (PRD #47 M1): Reduced Crossplane memory 4Gi → 2Gi, increased CRD wait timeout 10min → 20min for cold image pulls
- Demo cluster (PRD #47 M1): Verified clean GKE run — 1,040 CRDs, all 37 providers healthy, Crossplane stable at 618Mi/2Gi
