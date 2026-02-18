# PRD #28: Cluster Sync Watcher

**Status**: Not Started
**Created**: 2026-02-18
**GitHub Issue**: [#28](https://github.com/wiggitywhitney/cluster-whisperer/issues/28)

---

## Problem Statement

The capability inference pipeline (PRD #25) and resource instance sync (PRD #26) run as one-shot batch jobs. Once they finish, the vector database is a snapshot in time. When someone installs a new CRD or deploys a new workload, the vector database has no idea — it's stale until someone manually re-runs the pipeline.

For a live KubeCon demo, this matters: "I just installed a new database CRD — can the agent find it?" The answer needs to be yes, without asking the audience to wait while you manually re-run a script.

## Solution

A lightweight watcher process that:
1. Polls the Kubernetes cluster on a configurable interval to detect changes (new/removed CRDs, resource instance changes)
2. Re-triggers the appropriate sync pipeline (capability inference or instance sync) when changes are detected
3. Exposes a manual trigger so you can force an immediate sync (useful for live demos)

This is **not** a full Kubebuilder operator. It's a simple polling loop in TypeScript that reuses existing kubectl helpers and calls the batch pipelines from PRDs #25 and #26.

### KubeCon Demo Context

On stage: install a new CRD → trigger sync → show the agent can now find it via semantic search. The manual trigger makes the demo reliable and predictable while the background polling handles the "real deployment" story.

### How Viktor Does It (for reference)

Viktor's `dot-ai-controller` is a Go/Kubebuilder operator with dynamic informers, debouncing (10s window), last-state-wins dedup, and hourly full resyncs. It's production-grade but complex. See `docs/viktors-pipeline-assessment.md` for the full analysis.

Our version trades real-time push notifications for simplicity: poll on an interval, diff against the last known state, and re-trigger pipelines when something changes.

---

## Success Criteria

- [ ] Watcher detects new, modified, and removed CRDs in the cluster
- [ ] Watcher detects resource instance changes (created, deleted)
- [ ] CRD changes trigger capability inference pipeline (PRD #25)
- [ ] Instance changes trigger resource instance sync pipeline (PRD #26)
- [ ] Manual trigger forces an immediate sync cycle
- [ ] Watcher runs as a long-lived process with configurable poll interval
- [ ] Documentation explains how the watcher works and how to use the manual trigger

## Milestones

- [ ] **M1**: CRD Change Detection
  - Poll `kubectl get crd` (or K8s API) on a configurable interval
  - Diff current CRD list against last known state
  - Detect additions, removals, and version changes
  - Log detected changes with clear output
  - Store last-known state for comparison

- [ ] **M2**: CRD Sync Trigger
  - When new/changed CRDs are detected, re-trigger PRD #25's capability inference pipeline for those specific resources
  - When CRDs are removed, remove their capability entries from the vector database
  - Handle errors gracefully (pipeline failure shouldn't crash the watcher)
  - Log sync actions and results

- [ ] **M3**: Resource Instance Change Detection
  - Poll resource instances across configured resource types
  - Diff current instances against last known state
  - Detect additions, removals, and metadata changes (labels, annotations)
  - Configurable resource type filter (watch all types or a curated list)

- [ ] **M4**: Instance Sync Trigger
  - When instance changes are detected, re-trigger PRD #26's resource instance sync for affected resource types
  - Handle deleted instances (remove from vector database)
  - Support full resync (re-sync everything) and incremental sync (only changed types)

- [ ] **M5**: Manual Trigger and CLI
  - Expose a manual trigger mechanism (CLI command, API endpoint, or MCP tool)
  - Manual trigger runs an immediate sync cycle for both CRDs and instances
  - Support triggering just CRD sync or just instance sync independently
  - Log progress during manual sync for demo visibility

- [ ] **M6**: End-to-End Demo Validation
  - Test the full flow: install CRD → watcher detects → pipeline runs → agent finds it
  - Test the manual trigger flow for live demo reliability
  - Test CRD removal flow: remove CRD → watcher detects → capability removed from vector DB
  - Document watcher setup, configuration, and demo usage

## Technical Approach

### Polling Architecture

```text
┌─────────────────────────────────────┐
│         Cluster Sync Watcher        │
│                                     │
│  ┌───────────┐    ┌──────────────┐  │
│  │ CRD Poll  │    │ Instance Poll│  │
│  │ (interval)│    │  (interval)  │  │
│  └─────┬─────┘    └──────┬───────┘  │
│        │                 │          │
│        ▼                 ▼          │
│  ┌───────────┐    ┌──────────────┐  │
│  │   Diff    │    │     Diff     │  │
│  │  Engine   │    │    Engine    │  │
│  └─────┬─────┘    └──────┬───────┘  │
│        │                 │          │
│        ▼                 ▼          │
│  ┌───────────┐    ┌──────────────┐  │
│  │ Trigger   │    │   Trigger    │  │
│  │ PRD #25   │    │   PRD #26    │  │
│  │ Pipeline  │    │   Pipeline   │  │
│  └───────────┘    └──────────────┘  │
│                                     │
│  ┌──────────────────────────────┐   │
│  │      Manual Trigger          │   │
│  │  (CLI / API / MCP tool)      │   │
│  └──────────────────────────────┘   │
└─────────────────────────────────────┘
```

### Change Detection Strategy

**CRD changes**: Compare the list of CRD names and resource versions from `kubectl get crd -o json` against the previous poll. A simple Set diff detects additions and removals. Resource version changes detect CRD schema updates.

**Instance changes**: Compare resource instance lists per type. Track by unique key (`namespace/apiVersion/kind/name`). Additions, removals, and label/annotation changes trigger a sync.

### State Storage

The watcher keeps last-known state **in memory** (not persisted). On restart, it does a full sync to establish baseline. This keeps the implementation simple — no database or file to manage.

### Configuration

```typescript
interface WatcherConfig {
  pollIntervalMs: number;        // Default: 300000 (5 minutes)
  crdWatchEnabled: boolean;      // Default: true
  instanceWatchEnabled: boolean; // Default: true
  resourceTypeFilter?: string[]; // Optional: only watch specific resource types
}
```

### Decisions Made

- **Polling over informers**: Simpler to implement, explain, and demo. A manual trigger covers the "show it working now" demo need. See discussion in GitHub issue #28.
- **In-memory state**: No persistence needed. Full sync on startup establishes baseline. Keeps implementation simple.

### Decisions Deferred to Implementation

- Exact manual trigger mechanism (CLI subcommand, HTTP endpoint, or MCP tool)
- Whether to run as a standalone process or integrate into the MCP server
- Optimal default poll interval for demo vs production scenarios
- Whether to debounce rapid changes (Viktor uses a 10s window)

## Dependencies

- **PRD #25** (Capability Inference Pipeline) — the CRD sync trigger calls this pipeline
- **PRD #26** (Resource Instance Sync) — the instance sync trigger calls this pipeline
- **PRD #7** (Vector Database Integration) — completed; provides the storage layer

## Out of Scope

- Kubernetes informers / watch API (could replace polling in a future enhancement)
- Full Kubebuilder operator or CRD-based configuration
- Webhook-based triggers (e.g., admission webhooks)
- Multi-cluster watching

---

## Design Decisions

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-02-18 | Polling over informers | Simpler to implement, explain on stage, and debug. Manual trigger covers demo needs. Informers can be added later as an enhancement. |
| 2026-02-18 | In-memory state (no persistence) | Full sync on startup establishes baseline. Avoids managing a state file or database. Keeps implementation minimal. |

---

## Progress Log

*Progress will be logged here as milestones are completed.*
