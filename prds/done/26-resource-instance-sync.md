# PRD #26: Resource Instance Sync

**Status**: Complete
**Created**: 2026-02-11
**Completed**: 2026-02-20
**GitHub Issue**: [#26](https://github.com/wiggitywhitney/cluster-whisperer/issues/26)

---

## Problem Statement

The agent can discover what resource *types* exist (via PRD #25's capability inference), but it also needs to know what resource *instances* are currently running in the cluster. When a developer asks "what databases are deployed?", the agent needs to find actual running instances across many resource types.

The agent already has `kubectl` tools for querying instances at runtime, but this doesn't scale well when the developer doesn't know which resource types to look for. Pre-indexing instance metadata in the vector database enables the agent to search across all resource types in a single query.

## Solution

Build a sync mechanism that:
1. Discovers Kubernetes resource instances across all (or selected) resource types
2. Extracts metadata (name, namespace, kind, apiVersion, labels, annotations)
3. Stores instance metadata in the vector database (via PRD #7's interface) for search

This complements PRD #25 (capabilities tell you what's *possible*, instances tell you what *exists*).

### The "Semantic Bridge" Pattern

The two collections work together:
1. User asks: "what databases are running?"
2. Agent searches **capabilities** (PRD #25) for "database" → finds relevant resource types
3. Agent searches **resource instances** (this PRD) filtered to those types → finds actual running instances
4. Agent synthesizes an answer

### How Viktor Does It (for reference)

Viktor's `dot-ai-controller` is a Go Kubebuilder operator that:
- Watches nearly all resources via dynamic informers
- Debounces changes (10s window) with last-state-wins dedup
- Batches and POSTs metadata to the MCP server via REST
- Runs full resync every 60 minutes for eventual consistency
- Syncs: namespace, name, kind, apiVersion, labels, description annotations, timestamps
- Does NOT sync: spec, status, managedFields (fetched on-demand)

Our version will be lighter-weight. See `docs/viktors-pipeline-assessment.md` for full analysis.

---

## Success Criteria

- [x] Sync mechanism discovers resource instances from a live cluster
- [x] Instance metadata is stored in the vector database via PRD #7's interface
- [x] Agent can search instances by semantic query or metadata filters
- [x] Sync is vector-DB-agnostic (works with Chroma now, Qdrant later)
- [x] Documentation explains how the sync mechanism works

## Milestones

- [x] **M1**: Resource Instance Discovery
  - Enumerate resource types to sync (configurable list or discover all)
  - For each resource type, list instances via kubectl or K8s API
  - Extract metadata per instance: namespace, name, kind, apiVersion, labels, key annotations
  - Filter out high-churn / low-value resources (Events, Leases, EndpointSlices)
  - Output: a list of resource instances with metadata, ready for storage

- [x] **M2**: Storage and Search
  - Construct embedding text per instance (kind + name + namespace + labels + annotations)
  - Store instance metadata in the vector DB via PRD #7's interface
  - Store metadata for filtering (namespace, kind, apiGroup, labels)
  - Verify search works: "nginx" → finds nginx deployments/pods/services
  - Verify filter works: "all Deployments in namespace default" → filters by metadata

- [x] **M3**: Sync Runner
  - Wrap as a runnable tool (CLI command, npm script, or startup hook)
  - Support full sync (load everything) and incremental sync (only changed resources)
  - Handle deletes (resources removed from cluster should be removed from vector DB)
  - Log progress

- [x] **M4**: End-to-End Validation
  - Test the "semantic bridge" pattern with PRD #25: capabilities search → instance filter
  - Test with the demo cluster scenario
  - Document the sync setup and usage

## Technical Approach

### Instance Document Schema

Each document represents a single running resource instance:

```typescript
{
  id: "default/apps/v1/Deployment/nginx",  // namespace/apiVersion/Kind/name
  text: "Deployment nginx | namespace: default | apiVersion: apps/v1 | labels: app=nginx",
  metadata: {
    namespace: "default",
    name: "nginx",
    kind: "Deployment",
    apiVersion: "apps/v1",
    apiGroup: "apps",
    labels: "app=nginx",       // comma-separated key=value (flat string for Chroma)
    source: "resource-sync",
  }
}
```

### What Gets Synced Per Instance

| Field | Source | Notes |
|-------|--------|-------|
| namespace | `obj.metadata.namespace` | `_cluster` for cluster-scoped |
| name | `obj.metadata.name` | |
| kind | resource type | |
| apiVersion | resource type | |
| labels | `obj.metadata.labels` | All labels |
| annotations | `obj.metadata.annotations` | Filtered to `description` annotations only |
| createdAt | `obj.metadata.creationTimestamp` | |

**Not synced**: spec, status, managedFields. These are fetched on-demand via kubectl tools when the agent needs details.

### Decisions Deferred to Implementation

- How to handle large clusters (pagination, batching)

## Dependencies

- **PRD #7** (Vector Database Integration) — must have the vector DB interface and Chroma backend working
- Kubernetes cluster access (kubeconfig)

## Out of Scope

- Real-time Kubernetes controller / informer-based watching (could be a future enhancement)
- Capability inference (PRD #25)
- Spec/status sync (the agent uses kubectl tools for on-demand detail)
- Qdrant backend (PRD #7 provides the interface; Qdrant implementation is a future PRD)

---

## Design Decisions

### DD-1: kubectl subprocess over Kubernetes JavaScript client
**Decision**: Use `kubectl get <type> -A -o json` via the existing `executeKubectl` utility rather than adding the `@kubernetes/client-node` library.
**Rationale**: The project already uses kubectl subprocess execution with shell-injection protection (`spawnSync` with args array). Adding a K8s client library would introduce a new dependency and a different interaction pattern. kubectl JSON output provides all the metadata we need.

### DD-2: Reuse PRD #25 parsing functions
**Decision**: Import `parseApiResources`, `filterResources`, and `extractGroup` from `discovery.ts` rather than reimplementing.
**Rationale**: Both pipelines need to enumerate and filter resource types. The capability pipeline already has well-tested parsing logic for `kubectl api-resources -o wide` output. Instance discovery adds a `list` verb requirement on top of the existing filters.

### DD-3: Separate instances collection
**Decision**: Store instances in a dedicated `instances` collection, separate from the `capabilities` collection.
**Rationale**: Capabilities describe resource *types* (one doc per kind), instances describe *running objects* (many docs per kind). Separate collections allow independent sync cycles and clear semantic separation. `INSTANCES_COLLECTION` constant was already defined in `vectorstore/index.ts`.

### DD-4: Batch-only sync (no informers)
**Decision**: Implement batch sync only (`kubectl get` per type) without real-time Kubernetes watching/informers.
**Rationale**: Informers require a long-running controller process and add significant complexity. Batch sync is sufficient for the POC — the agent can re-sync on demand. Real-time watching is explicitly out of scope per the PRD.

### DD-5: Instance ID format
**Decision**: Use `namespace/apiVersion/Kind/name` as the canonical instance ID (e.g., `default/apps/v1/Deployment/nginx`). Cluster-scoped resources use `_cluster` as namespace.
**Rationale**: Including the full apiVersion (not just group) ensures uniqueness even if a resource exists across multiple API versions. The format is human-readable and naturally hierarchical.

### DD-6: Labels as comma-separated flat strings in metadata
**Decision**: Store labels as a comma-separated `key=value` string (e.g., `"app=nginx,tier=frontend"`) rather than nested objects.
**Rationale**: Chroma metadata values must be `string | number | boolean` — no nested objects allowed. Comma-separated strings follow the same pattern used for `providers` in the capabilities collection. Labels are also included in the embedding text for semantic search, so individual label filtering via metadata is not needed for the POC.

### DD-7: Full sync only (no incremental flag)
**Decision**: Implement a single sync mode rather than separate full/incremental modes. Every sync discovers all instances, deletes stale documents, and upserts all current instances.
**Rationale**: `vectorStore.store()` uses upsert semantics, so re-storing unchanged instances is harmless. Stale cleanup (diff DB state against cluster state, delete removed docs) runs on every sync. An `--incremental` flag would add API surface with no behavioral difference — both modes would execute identically. The flag can be added later if there's a real performance need (e.g., skipping embedding API calls for unchanged documents).

---

## Progress Log

### 2026-02-19: M1 Resource Instance Discovery complete
- Added `ResourceInstance` and `InstanceDiscoveryOptions` types to `src/pipeline/types.ts`
- Created `src/pipeline/instance-discovery.ts` with discovery orchestrator and pure helper functions
- Created `src/pipeline/instance-discovery.test.ts` with 25 unit tests (all passing)
- Reuses PRD #25's `parseApiResources`, `filterResources`, `extractGroup` — no code duplication
- Supports optional `resourceTypes` filter to narrow sync scope
- Uses `-A` flag for namespaced resources, omits for cluster-scoped
- Filters annotations to description-like only (`description` or `*/description`)
- Handles kubectl failures per-type gracefully (warns and continues)
- Full test suite: 109 passed, 21 skipped (integration tests requiring infrastructure)

### 2026-02-20: M2 Storage and Search complete
- Created `src/pipeline/instance-storage.ts` with `instanceToDocument()` and `storeInstances()` orchestrator
- Created `src/pipeline/instance-storage.test.ts` with 24 unit tests (all passing)
- Created `src/pipeline/instance-storage.integration.test.ts` with 10 integration tests for search and filter verification
- Follows PRD #25's `storage.ts` pattern: pure conversion function + async orchestrator
- Embedding text: pipe-delimited sections (kind+name | namespace | apiVersion | labels | annotations)
- Metadata: flat fields (namespace, name, kind, apiVersion, apiGroup, labels as comma-separated, source)
- Labels flattened to comma-separated `key=value` strings (DD-6) — Chroma requires flat metadata
- Integration tests verify semantic search ("nginx" → finds Deployment + Service) and metadata filtering (kind, namespace, combined)
- Full test suite: 133 passed, 31 skipped (integration tests requiring infrastructure)

### 2026-02-20: M3 Sync Runner complete
- Created `src/pipeline/instance-runner.ts` with `syncInstances()` orchestrator and `SyncInstancesOptions`/`SyncInstancesResult` types
- Created `src/pipeline/instance-runner.test.ts` with 16 unit tests (all passing)
- Orchestrates: discover instances → delete stale documents → store instances
- Stale cleanup: queries existing DB document IDs via `keywordSearch`, diffs against discovered instance IDs, deletes removed entries via `vectorStore.delete()`
- Added `sync-instances` CLI subcommand to `src/index.ts` with `--dry-run` and `--chroma-url` flags
- Instance sync validates only `VOYAGE_API_KEY` + kubectl (no `ANTHROPIC_API_KEY` needed — no LLM inference step)
- Exported all PRD #26 types and functions from `src/pipeline/index.ts`
- Design decision DD-7: single sync mode only, no incremental flag (YAGNI — both modes would behave identically)
- Full test suite: 149 passed, 31 skipped (integration tests requiring infrastructure)

### 2026-02-20: M4 End-to-End Validation complete
- Created `src/pipeline/semantic-bridge.integration.test.ts` with 5 integration tests validating the two-step semantic bridge pattern (capabilities search → instance filter)
- Created `src/pipeline/instance-runner.integration.test.ts` with 3 integration tests (full pipeline, dry-run, stale cleanup)
- Integration tests discovered and fixed a real bug: `deleteStaleDocuments()` queried the instances collection before initialization on first-ever sync. Fix: explicit `vectorStore.initialize()` before stale cleanup in `instance-runner.ts`
- Created `docs/resource-instance-sync.md` documenting the pipeline: problem, solution, prerequisites, CLI usage, sync steps, data structure, embedding format, metadata schema, semantic bridge pattern, architecture, and comparison with capability inference
- Fixed position-dependent assertion in `instance-storage.integration.test.ts` (used `results.find()` instead of `results[0]` for resilience to parallel test execution)
- Full test suite: 188 passed, 39 skipped (integration tests requiring infrastructure)
- All milestones (M1–M4) and all success criteria complete
