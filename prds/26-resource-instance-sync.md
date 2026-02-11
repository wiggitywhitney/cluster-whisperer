# PRD #26: Resource Instance Sync

**Status**: Not Started
**Created**: 2026-02-11
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

- [ ] Sync mechanism discovers resource instances from a live cluster
- [ ] Instance metadata is stored in the vector database via PRD #7's interface
- [ ] Agent can search instances by semantic query or metadata filters
- [ ] Sync is vector-DB-agnostic (works with Chroma now, Qdrant later)
- [ ] Documentation explains how the sync mechanism works

## Milestones

- [ ] **M1**: Resource Instance Discovery
  - Enumerate resource types to sync (configurable list or discover all)
  - For each resource type, list instances via kubectl or K8s API
  - Extract metadata per instance: namespace, name, kind, apiVersion, labels, key annotations
  - Filter out high-churn / low-value resources (Events, Leases, EndpointSlices)
  - Output: a list of resource instances with metadata, ready for storage

- [ ] **M2**: Storage and Search
  - Construct embedding text per instance (kind + name + namespace + labels + annotations)
  - Store instance metadata in the vector DB via PRD #7's interface
  - Store metadata for filtering (namespace, kind, apiGroup, labels)
  - Verify search works: "nginx" → finds nginx deployments/pods/services
  - Verify filter works: "all Deployments in namespace default" → filters by metadata

- [ ] **M3**: Sync Runner
  - Wrap as a runnable tool (CLI command, npm script, or startup hook)
  - Support full sync (load everything) and incremental sync (only changed resources)
  - Handle deletes (resources removed from cluster should be removed from vector DB)
  - Log progress

- [ ] **M4**: End-to-End Validation
  - Test the "semantic bridge" pattern with PRD #25: capabilities search → instance filter
  - Test with the demo cluster scenario
  - Document the sync setup and usage

## Technical Approach

### Instance Document Schema

Each document represents a single running resource instance:

```typescript
{
  id: "default/apps/v1/Deployment/nginx",  // namespace/group/version/kind/name
  document: "Deployment nginx | namespace: default | apiVersion: apps/v1 | labels: app=nginx",
  metadata: {
    namespace: "default",
    name: "nginx",
    kind: "Deployment",
    apiVersion: "apps/v1",
    apiGroup: "apps",
    labels: { app: "nginx" },
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

- Whether to sync all resource types or a curated list
- Whether to use `kubectl` subprocess or the Kubernetes JavaScript client
- Whether to implement real-time watching (informers) or batch-only sync
- How to handle large clusters (pagination, batching)
- Whether instances go in the same collection as capabilities or a separate one

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

*Decisions will be logged here as they're made during implementation.*

---

## Progress Log

*Progress will be logged here as milestones are completed.*
