# PRD #42: Capability Scan REST Endpoint

**Status**: Complete
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

- [x] `POST /api/v1/capabilities/scan` endpoint receives CRD names and triggers inference for those resources
- [x] New CRD capabilities appear in the vector database after the endpoint processes them
- [x] Deleted CRDs are removed from the capabilities collection
- [x] Endpoint reuses existing pipeline functions from PRD #25 (no reimplementation)
- [x] The endpoint works with the k8s-vectordb-sync controller's payload format
- [x] Error handling: 400 for bad payload (async processing means pipeline errors are logged, not returned as HTTP status)
- [x] Tests cover the endpoint, pipeline integration, and error paths

## Milestones

- [x] **M1**: Capability Scan Endpoint (Upserts)
  - Add `POST /api/v1/capabilities/scan` route to the Hono server
  - Define Zod schema for the scan payload (resource names to scan)
  - Wire endpoint to existing pipeline: `discoverResources()` scoped to specific resource names → `inferCapabilities()` → `storeCapabilities()`
  - Mount route in `server.ts` alongside the existing instances route
  - Unit tests for route handler, payload validation, and pipeline integration
  - Decided: asynchronous fire-and-forget (return 202, process in background)

- [x] **M2**: Capability Delete Support (folded into M1)
  - Handle delete requests — remove capability entries from the capabilities collection by resource name
  - Reuse `vectorStore.delete()` with capability document IDs
  - Unit tests for delete path

- [x] **M3**: Pipeline Scoping (folded into M1)
  - Added `resourceNames?: string[]` to `DiscoveryOptions` — `discoverResources()` skips `kubectl explain` for non-matching resources
  - Unit tests for scoped discovery (6 tests covering matching, no matches, empty filter, kubectl explain call count)

- [x] **M4**: Integration Testing
  - Integration tests against real ChromaDB: POST scan payload → verify capabilities appear in vector DB
  - Integration tests for delete: POST delete payload → verify capabilities removed
  - Contract tests matching the controller's expected payload format
  - End-to-end: install CRD → controller detects → POSTs to scan endpoint → agent finds new capability (deferred — requires cross-repo CI with Kind cluster and k8s-vectordb-sync controller)

- [x] **M5**: Documentation
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

**Overlap handling**: If the same resource name appears in both `upserts` and `deletes`, deletes are processed first, then upserts. This matches the instance sync endpoint's behavior (PRD #35) — the delete removes the old entry and the upsert recreates it with fresh inference.

### Processing Flow

```text
Controller POSTs: { upserts: ["certificates.cert-manager.io"], deletes: ["old.example.io"] }
    |
    v
Zod validation (synchronous — 400 on bad input)
    |
    v
202 Accepted: { status: "accepted", upserts: 1, deletes: 1 }
    |
    v  (background — fire-and-forget)
    |
    ├── vectorStore.delete("capabilities", ["old.example.io"])
    |
    └── discoverResources({ resourceNames: ["certificates.cert-manager.io"] })
            |  (kubectl api-resources → filter to requested names → kubectl explain --recursive)
            v
        inferCapabilities() — LLM inference for each discovered resource
            |  (schema → Haiku → structured JSON → ResourceCapability)
            v
        storeCapabilities() — embed and store in "capabilities" collection
```

Pipeline failures are logged and observable via OTel spans (PRD #37), not returned to the controller.

### Scoped Discovery

The existing `discoverResources()` discovers all resources in the cluster. The endpoint needs to scope this to specific resources. Options:

1. **Filter after discovery**: Run full `kubectl api-resources`, then filter the results to requested names before schema extraction. Simple but fetches unnecessary data.
2. **Pass a filter to discoverResources**: Add an optional `resourceNames` parameter to `DiscoveryOptions`. The function runs `kubectl api-resources` once but only extracts schemas for matching names. More efficient.

Option 2 is preferred — it avoids running `kubectl explain` for resources we don't need.

### Asynchronous Fire-and-Forget

The endpoint validates synchronously (400 on bad input) and returns 202 immediately. The pipeline runs in the background:
- Controller's 30s HTTP timeout is never close to hit
- A failed inference doesn't cause the controller to retry the whole batch
- cluster-whisperer can rate-limit LLM calls without back-pressuring the controller
- The endpoint is naturally idempotent — re-scanning the same CRD produces the same result

### API Key Requirements

The capability scan endpoint requires both `ANTHROPIC_API_KEY` (for LLM inference) and `VOYAGE_API_KEY` (for embedding). The instance sync endpoint only requires `VOYAGE_API_KEY`.

The endpoint is optionally mounted — `ServerDependencies.capabilities` must be provided for the route to exist. In practice, the CLI subcommand wires the real pipeline functions (which require the API keys). If keys are missing, the pipeline functions fail in the background and errors are logged.

## Dependencies

- **PRD #25** (Capability Inference Pipeline) — provides `discoverResources()`, `inferCapabilities()`, `storeCapabilities()`
- **PRD #35** (Instance Sync REST Endpoint) — provides the server architecture, Hono patterns, and Zod validation approach
- **k8s-vectordb-sync controller** — will add CRD event detection and POST to this endpoint (separate PRD in that repo)

## Out of Scope

- CRD event detection in the controller (handled by a separate PRD in the k8s-vectordb-sync repo)
- Authentication/authorization on the endpoint (consistent with the instance sync endpoint, which also has no auth — both are internal APIs on a private network)
- Rate limiting or queuing for large batches
- Webhook-based triggers

---

## Design Decisions

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-02-25 | Separate endpoint (`/capabilities/scan`) not shared with `/instances/sync` | Different processing pipelines (LLM inference vs embedding only), different latency profiles (seconds vs milliseconds), different API key requirements, different volume patterns. REST convention: different resources = different endpoints. |
| 2026-02-25 | ~~Synchronous processing for initial implementation~~ Superseded by 2026-02-26 async decision | Originally planned synchronous. Revised after analyzing controller timeout constraints. |
| 2026-02-25 | Resource names as fully qualified strings | Matches `kubectl api-resources` format and what `discoverResources()` already uses internally. The controller can construct these from CRD metadata. |
| 2026-02-26 | Async fire-and-forget (202) instead of synchronous (200) | Controller shouldn't wait for LLM inference (~5s/resource). Prevents timeout issues, decouples retry semantics — controller retries delivery, not processing. Pipeline failures observable via OTel spans. |
| 2026-02-26 | Own deps interface (`CapabilitiesRouteDeps`) per route | Route factories declare what they need. Independently testable with minimal stubs. No coupling between routes via shared `ServerDependencies`. |
| 2026-02-26 | Optional route mounting via `ServerDependencies.capabilities` | Capabilities route only mounts when deps are provided. Avoids always-on mounting and 503 checks for missing API keys. |
| 2026-02-26 | Controller field names changed from `added`/`deleted` to `upserts`/`deletes` | Server defines the API contract. Consistency with instance sync endpoint. `upserts` describes intent (idempotent desired state), not event (`added`). |

---

## Progress Log

- **2026-02-26**: Completed M1 (endpoint), M2 (deletes), and M3 (scoped discovery) in a single implementation pass. M2 and M3 were folded into M1 as they are tightly coupled. Created: `scan-payload.ts` (Zod schema), `capabilities.ts` (route handler with async fire-and-forget), modified `discovery.ts` (resourceNames filter) and `server.ts` (optional route mounting). 33 new unit tests, 256 total passing. Remaining: M4 (integration tests) and M5 (documentation).
- **2026-02-26**: Completed M4 (integration testing). Created `capabilities.integration.test.ts` with 12 tests across 5 describe blocks: upsert verification against real ChromaDB (POST → 202 → poll → capabilities stored with correct metadata), delete verification (seed via `storeCapabilities()`, delete via endpoint, verify removal), mixed upserts+deletes with atomic assertion (both conditions checked in single `waitFor` to prevent race), controller payload contract (Go nil slices, empty objects, CRD name format, 400 paths), and response shape contract. Uses `vi.waitFor()` polling for async fire-and-forget verification. Reuses canned kubectl fixtures from `runner.integration.test.ts`. 268 total tests (256 unit + 12 integration). Full cross-repo e2e test (CRD install → controller → endpoint → agent) deferred to CI workflow. Remaining: M5 (documentation).
- **2026-02-26**: Completed M5 (documentation). Added "Push-Based Scan via HTTP Endpoint" section to `docs/capability-inference-pipeline.md` covering processing flow, payload format, async 202 response, scoped discovery, API key requirements, and pull vs push comparison. Updated `docs/resource-instance-sync.md` with capability scan route in endpoint table and CRD-triggered scan cross-references. Updated README with capability scan in endpoint table, `Optional*` Anthropic key for `serve`, capability scan payload example, updated architecture diagram, and new files in project structure. PRD #42 complete — all milestones (M1–M5) and success criteria (7/7) done.
