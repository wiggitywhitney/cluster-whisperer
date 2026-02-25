# PRD #42: Capability Scan REST Endpoint

**Status**: Open
**Created**: 2026-02-25
**GitHub Issue**: [#42](https://github.com/wiggitywhitney/cluster-whisperer/issues/42)

---

## Problem Statement

When new CRDs are installed in a cluster (e.g., cert-manager adding `certificates.cert-manager.io`, `issuers.cert-manager.io`), the k8s-vectordb-sync controller correctly picks up the new resource instances (pods, services, deployments) and pushes them to the vector database via `POST /api/v1/instances/sync`. But the capabilities collection — which stores LLM-inferred descriptions of what each resource *type* can do — stays stale.

Currently the only way to update capabilities is `cluster-whisperer sync`, a CLI command that re-scans the entire cluster. There is no way for the controller to trigger capability inference for specific new CRDs via HTTP.

This gap was discovered during a live demo: cert-manager installed 6 new CRDs, the controller synced all the new instances, but the agent couldn't answer "what certificate management capabilities does this cluster have?" because the capabilities collection didn't know about the new resource types.

### Origin

PRD #28 (Cluster Sync Watcher) originally planned both CRD watching and instance watching. The instance half was implemented as the k8s-vectordb-sync controller (separate Go repo). The CRD-watching half was dropped. This PRD closes that gap by giving the controller an endpoint to call when it detects CRD events.

### Reference: Viktor's dot-ai-controller

Viktor's controller has a `CapabilityScanConfig` CRD that triggers capability scans when new CRDs appear. His controller POSTs to a capability scan endpoint on his MCP server, which runs LLM inference on the CRD schemas and stores the results. See `docs/viktors-pipeline-assessment.md` for the full analysis.

---

## Solution

Add a `POST /api/v1/capabilities/scan` REST endpoint to cluster-whisperer's HTTP server. This endpoint:

1. Receives a list of CRD resource names to scan (or delete) from the controller
2. For upserts: runs the existing capability inference pipeline (`discoverResources` → `inferCapabilities` → `storeCapabilities` from PRD #25) scoped to those specific resources
3. For deletes: removes the capability entries from the vector database

This follows the same architectural pattern as the instance sync endpoint (PRD #35): the controller is a pure HTTP client that watches Kubernetes and forwards metadata. cluster-whisperer handles the expensive work (LLM inference, embedding, storage).

### Why a Separate Endpoint

The capability scan endpoint has fundamentally different characteristics from instance sync:

- **Processing time**: Instance sync is fast (embed metadata, store). Capability scan is slow (run `kubectl explain`, call LLM for inference per resource — 4-6 seconds each).
- **Volume**: Instance sync handles high-volume batches (50 upserts every few seconds). Capability scans are rare (CRDs change infrequently).
- **Cost**: Instance sync only calls the embedding API. Capability scan calls both the LLM API (Anthropic) and the embedding API (Voyage AI).
- **Response contract**: Instance sync returns immediately. Capability scan may need to return 202 Accepted and process asynchronously for large batches, or the controller may need a longer timeout.

---

## Success Criteria

- [ ] `POST /api/v1/capabilities/scan` endpoint receives CRD names and triggers inference for those resources
- [ ] New CRD capabilities appear in the vector database after the endpoint processes them
- [ ] Deleted CRDs are removed from the capabilities collection
- [ ] Endpoint reuses existing pipeline functions from PRD #25 (no reimplementation)
- [ ] The endpoint works with the k8s-vectordb-sync controller's payload format
- [ ] Error handling matches instance sync patterns (400 for bad payload, 500 for server errors)
- [ ] Tests cover the endpoint, pipeline integration, and error paths

## Milestones

- [ ] **M1**: Capability Scan Endpoint (Upserts)
  - Add `POST /api/v1/capabilities/scan` route to the Hono server
  - Define Zod schema for the scan payload (resource names to scan)
  - Wire endpoint to existing pipeline: `discoverResources()` scoped to specific resource names → `inferCapabilities()` → `storeCapabilities()`
  - Mount route in `server.ts` alongside the existing instances route
  - Unit tests for route handler, payload validation, and pipeline integration
  - Decide: synchronous (block until inference completes) vs asynchronous (return 202, process in background)

- [ ] **M2**: Capability Delete Support
  - Handle delete requests — remove capability entries from the capabilities collection by resource name
  - Reuse `vectorStore.delete()` with capability document IDs
  - Unit tests for delete path

- [ ] **M3**: Pipeline Scoping
  - Modify `discoverResources()` (or create a wrapper) to accept a filter for specific resource names instead of discovering everything
  - This is the key change: the existing pipeline always discovers all resources. The endpoint needs to discover only the resources the controller specified.
  - Unit and integration tests for scoped discovery

- [ ] **M4**: Integration Testing
  - Integration tests against real ChromaDB: POST scan payload → verify capabilities appear in vector DB
  - Integration tests for delete: POST delete payload → verify capabilities removed
  - Contract tests matching the controller's expected payload format
  - End-to-end: install CRD → controller detects → POSTs to scan endpoint → agent finds new capability

- [ ] **M5**: Documentation
  - Document the new endpoint in `docs/capability-inference-pipeline.md`
  - Update `docs/resource-instance-sync.md` to reference the capability scan endpoint
  - Update README with the capability scan endpoint details

## Technical Approach

### Payload Format

The controller will POST this structure when CRDs are added or removed:

```json
{
  "upserts": [
    "certificates.cert-manager.io",
    "issuers.cert-manager.io",
    "clusterissuers.cert-manager.io"
  ],
  "deletes": [
    "old-resource.example.io"
  ]
}
```

Resource names use the fully qualified format that `kubectl api-resources` produces (e.g., `certificates.cert-manager.io`), which matches what `discoverResources()` already uses internally.

### Processing Flow (Upserts)

```text
Controller POSTs: { upserts: ["certificates.cert-manager.io"] }
    |
    v
Zod validation
    |
    v
discoverResources() — scoped to just those resource names
    |  (kubectl api-resources → filter to requested names → kubectl explain --recursive)
    v
inferCapabilities() — LLM inference for each discovered resource
    |  (schema → Haiku → structured JSON → ResourceCapability)
    v
storeCapabilities() — embed and store in "capabilities" collection
    |
    v
200 OK: { scanned: 1, stored: 1 }
```

### Processing Flow (Deletes)

```text
Controller POSTs: { deletes: ["old-resource.example.io"] }
    |
    v
Zod validation
    |
    v
vectorStore.delete("capabilities", ["old-resource.example.io"])
    |  (document IDs in capabilities collection match resource names)
    v
200 OK: { deleted: 1 }
```

### Scoped Discovery

The existing `discoverResources()` discovers all resources in the cluster. The endpoint needs to scope this to specific resources. Options:

1. **Filter after discovery**: Run full `kubectl api-resources`, then filter the results to requested names before schema extraction. Simple but fetches unnecessary data.
2. **Pass a filter to discoverResources**: Add an optional `resourceNames` parameter to `DiscoveryOptions`. The function runs `kubectl api-resources` once but only extracts schemas for matching names. More efficient.

Option 2 is preferred — it avoids running `kubectl explain` for resources we don't need.

### Synchronous vs Asynchronous

For the initial implementation, synchronous processing is simpler and sufficient:
- CRD changes are rare (operator installs, not continuous)
- Typical batch size is small (1-10 CRDs per operator)
- At ~5 seconds per resource, a 10-CRD batch takes ~50 seconds
- The controller can use a longer HTTP timeout for this endpoint

If large batches become a problem, async (202 Accepted + background processing) can be added later.

### API Key Requirements

The capability scan endpoint requires both `ANTHROPIC_API_KEY` (for LLM inference) and `VOYAGE_API_KEY` (for embedding). The instance sync endpoint only requires `VOYAGE_API_KEY`. The server startup should validate that both keys are available when the capability scan endpoint is enabled.

## Dependencies

- **PRD #25** (Capability Inference Pipeline) — provides `discoverResources()`, `inferCapabilities()`, `storeCapabilities()`
- **PRD #35** (Instance Sync REST Endpoint) — provides the server architecture, Hono patterns, and Zod validation approach
- **k8s-vectordb-sync controller** — will add CRD event detection and POST to this endpoint (separate PRD in that repo)

## Out of Scope

- CRD event detection in the controller (handled by a separate PRD in the k8s-vectordb-sync repo)
- Authentication/authorization on the endpoint
- Rate limiting or queuing for large batches
- Webhook-based triggers

---

## Design Decisions

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-02-25 | Separate endpoint (`/capabilities/scan`) not shared with `/instances/sync` | Different processing pipelines (LLM inference vs embedding only), different latency profiles (seconds vs milliseconds), different API key requirements, different volume patterns. REST convention: different resources = different endpoints. |
| 2026-02-25 | Synchronous processing for initial implementation | CRD changes are rare and batches are small. Simpler implementation. Async can be added later if needed. |
| 2026-02-25 | Resource names as fully qualified strings | Matches `kubectl api-resources` format and what `discoverResources()` already uses internally. The controller can construct these from CRD metadata. |

---

## Progress Log

*Progress will be logged here as milestones are completed.*
