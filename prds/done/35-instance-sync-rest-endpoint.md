# PRD #35: Instance Sync REST Endpoint

**Status**: Complete
**Created**: 2026-02-21
**GitHub Issue**: [#35](https://github.com/wiggitywhitney/cluster-whisperer/issues/35)

---

## Problem Statement

The k8s-vectordb-sync controller watches Kubernetes clusters for resource changes and pushes batched instance metadata over HTTP. Its REST client is complete — 8 contract tests passing, retry logic with exponential backoff, empty payload optimization, and 4xx/5xx error handling. But cluster-whisperer has no HTTP endpoint to receive these payloads.

Currently, cluster-whisperer syncs instances via the `sync-instances` CLI subcommand, which runs kubectl internally to discover resources. The controller replaces that pull-based approach with a push-based one: the controller watches the cluster and pushes changes as they happen, rather than requiring a manual re-run.

This corresponds to k8s-vectordb-sync PRD #1, M3. The controller side is done. The cluster-whisperer side is the remaining piece. Once this endpoint exists, both repos can move to M6 (end-to-end validation).

## Solution

Add a `POST /api/v1/instances/sync` endpoint using Hono (lightweight HTTP framework), exposed via a new `cluster-whisperer serve` CLI subcommand. The endpoint is a thin wrapper: parse the JSON payload, validate with Zod, call existing pipeline functions, return a status code.

### Why Hono

- ~13KB minified, zero dependencies — proportional to scope (1 POST route + health check)
- First-class Zod integration via `@hono/zod-validator` — Zod is already in the project
- Web Standards (Fetch API) — the most portable starting point if we ever need to swap frameworks
- TypeScript-first with automatic type inference from validation schemas

### Why `cluster-whisperer serve` Subcommand

- Matches existing CLI pattern (`sync`, `sync-instances` are already Commander.js subcommands)
- Keeps the single `cluster-whisperer` binary — no new `bin` entry in package.json
- Separate process from MCP server (stdio transport can't share with HTTP)
- In Kubernetes: runs as a separate container in the same pod, or a separate Deployment

---

## Success Criteria

- [x] `POST /api/v1/instances/sync` accepts the controller's JSON payload format
- [x] Upserts flow through `instanceToDocument()` → `storeInstances()` pipeline
- [x] Deletes remove instances from the vector DB by ID
- [x] Returns 200 on success, 4xx on bad requests, 5xx on transient failures
- [x] Empty payloads return 200 with no processing (defensive — controller typically skips them, but endpoint must tolerate if sent)
- [x] `cluster-whisperer serve` starts the HTTP server on a configurable port
- [x] `GET /healthz` returns 200 (liveness — is the process alive)
- [x] `GET /readyz` returns 200 only when ChromaDB is reachable (readiness — can it serve traffic)
- [x] Contract tests validate endpoint behavior matches controller expectations
- [x] End-to-end test with k8s-vectordb-sync controller succeeds

## Milestones

- [x] **M1**: HTTP Server Foundation
  - [x] Install `hono`, `@hono/node-server`, `@hono/zod-validator`
  - [x] Create `src/api/server.ts` with Hono app and probe routes
  - [x] `GET /healthz` — liveness probe, always returns 200 if process is running
  - [x] `GET /readyz` — readiness probe, returns 200 only when ChromaDB is reachable (lightweight ping)
  - [x] Add `cluster-whisperer serve` subcommand to Commander.js CLI
  - [x] Options: `--port <number>` (default: 3000), `--chroma-url <url>` (default: CHROMA_URL env or http://localhost:8000)
  - [x] Verify server starts and both probes respond correctly

- [x] **M2**: Sync Endpoint — Upserts
  - [x] Create `POST /api/v1/instances/sync` route in `src/api/routes/instances.ts`
  - [x] Define Zod schema matching the controller's payload format (upserts + deletes arrays)
  - [x] Wire upserts through existing `instanceToDocument()` and `storeInstances()` pipeline
  - [x] Validate with Zod, return 400 for malformed payloads
  - [x] Return 200 on success, 500 on vector DB errors
  - [x] Handle empty upserts array (no processing, return 200)

- [x] **M3**: Sync Endpoint — Deletes
  - [x] Wire deletes through `vectorStore.delete(collection, ids)`
  - [x] Handle empty deletes array (no processing)
  - [x] Handle mixed payloads (upserts + deletes in same request): process deletes first, then upserts. If the same ID appears in both, the upsert recreates the item.
  - [x] Return 200 on success, 500 on vector DB errors

- [x] **M4**: Error Handling and Edge Cases
  - [x] Empty payload (both arrays empty or missing) returns 200
  - [x] Malformed JSON returns 400
  - [x] Invalid payload shape (fails Zod validation) returns 400 with error details
  - [x] Vector DB connection failure returns 500 (controller will retry)
  - [x] Large payloads handled correctly (controller batches, but test boundary)

- [x] **M5**: Contract Tests
  - [x] Unit tests for Zod schema validation (valid payloads, edge cases, malformed input)
  - [x] Integration tests: POST with upserts → verify documents in vector DB
  - [x] Integration tests: POST with deletes → verify documents removed from vector DB
  - [x] Integration tests: POST with mixed upserts + deletes → verify both operations
  - [x] Integration tests: empty payload → 200, no DB operations
  - [x] Integration tests: malformed payload → 400
  - [x] Integration tests: verify response codes match controller expectations (200, 4xx, 5xx)
  - [x] These tests should mirror the k8s-vectordb-sync contract tests from the controller side

- [x] **M6**: End-to-End Validation
  - [x] Run `cluster-whisperer serve` against a real ChromaDB instance
  - [x] Run k8s-vectordb-sync controller pointing at the endpoint
  - [x] Verify instances appear in vector DB after controller push
  - [x] Verify deleted instances are removed from vector DB
  - [x] Verify the agent can find pushed instances via semantic search
  - [x] Document the full setup and demo flow

## Technical Approach

### Payload Format (from k8s-vectordb-sync controller)

```json
{
  "upserts": [
    {
      "id": "default/apps/v1/Deployment/nginx",
      "namespace": "default",
      "name": "nginx",
      "kind": "Deployment",
      "apiVersion": "apps/v1",
      "apiGroup": "apps",
      "labels": { "app": "nginx", "tier": "frontend" },
      "annotations": { "description": "Main web server" },
      "createdAt": "2026-02-20T10:00:00Z"
    }
  ],
  "deletes": [
    "default/apps/v1/Deployment/old-service"
  ]
}
```

### Zod Schema

```typescript
import { z } from "zod";

const ResourceInstanceSchema = z.object({
  id: z.string(),
  namespace: z.string(),
  name: z.string(),
  kind: z.string(),
  apiVersion: z.string(),
  apiGroup: z.string(),
  labels: z.record(z.string()).default({}),
  annotations: z.record(z.string()).default({}),
  createdAt: z.string(), // ISO-8601 UTC (e.g., "2026-02-20T10:00:00Z")
});

const SyncPayloadSchema = z.object({
  upserts: z.array(ResourceInstanceSchema).nullable().transform(v => v ?? []).default([]),
  deletes: z.array(z.string()).nullable().transform(v => v ?? []).default([]),
});
```

### File Structure

```text
src/api/
  server.ts              # Hono app setup, health check, server start
  routes/
    instances.ts         # POST /api/v1/instances/sync handler
  schemas/
    sync-payload.ts      # Zod schemas for payload validation
```

### Request Flow

```text
Controller POST → Hono route → Zod validation
  ├─ Invalid → 400 response (controller won't retry)
  ├─ Empty payload → 200 response (no processing)
  └─ Valid payload (deletes first, then upserts):
       ├─ Deletes: payload.deletes → vectorStore.delete("instances", ids)
       ├─ Upserts: payload.upserts → instanceToDocument() → storeInstances()
       ├─ Both succeed → 200
       └─ DB error → 500 response (controller retries with backoff)
```

### CLI Subcommand

```typescript
program
  .command("serve")
  .description("Start HTTP server to receive instance sync from k8s-vectordb-sync controller")
  .option("--port <number>", "HTTP server port", "3000")
  .option("--chroma-url <url>", "Chroma server URL", process.env.CHROMA_URL || "http://localhost:8000")
  .action(async (options) => {
    // Initialize vector store, start Hono server
  });
```

### Controller Expectations (from k8s-vectordb-sync contract tests)

| Behavior | Expected | HTTP Code |
|----------|----------|-----------|
| Valid payload accepted | Controller gets success | 200 |
| Bad request (malformed JSON, invalid schema) | Controller does not retry | 4xx |
| Transient failure (DB down, timeout) | Controller retries with exponential backoff | 5xx |
| Empty payload (no upserts or deletes) | Controller skips the POST entirely, but endpoint must tolerate if sent | 200 (defensive) |
| Content-Type | `application/json` | — |
| Auth | None (out of scope) | — |

### Shared Business Logic

The endpoint reuses existing functions — no duplication:

| Function | Location | Used For |
|----------|----------|----------|
| `instanceToDocument()` | `src/pipeline/instance-storage.ts` | Convert ResourceInstance → VectorDocument |
| `storeInstances()` | `src/pipeline/instance-storage.ts` | Store VectorDocuments in ChromaDB |
| `vectorStore.delete()` | `src/vectorstore/chroma-backend.ts` | Remove documents by ID |
| `ChromaBackend` | `src/vectorstore/chroma-backend.ts` | Vector DB client |
| `VoyageEmbedding` | `src/vectorstore/voyage-embedding.ts` | Embedding provider for storeInstances |

### Type Alignment

The controller's Go `ResourceInstance` struct maps directly to the existing TypeScript `ResourceInstance` type in `src/pipeline/types.ts`. The Zod schema validates the JSON payload and produces the same shape. No type conversion layer needed — the controller's JSON output is the endpoint's input.

## Dependencies

- **k8s-vectordb-sync PRD #1** — controller's REST client (M3 complete, 8 contract tests passing)
- **PRD #26** (Resource Instance Sync) — provides `instanceToDocument()`, `storeInstances()`, and `ResourceInstance` type
- **PRD #7** (Vector Database Integration) — provides `ChromaBackend` and `VectorStore` interface
- Running ChromaDB instance for integration tests and production use
- Voyage AI API key for embedding generation during upserts

## Out of Scope

- Authentication/authorization on the endpoint (noted for future work)
- HTTPS/TLS termination (handled by ingress controller or service mesh in Kubernetes)
- Rate limiting
- Metrics/monitoring on the HTTP server (future: OTel instrumentation)
- WebSocket or SSE for real-time updates
- Multiple endpoints beyond sync and health check

---

## Design Decisions

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-02-21 | Hono over Express/Fastify/native http | ~13KB, zero deps, first-class Zod integration. Proportional to scope (1 route). Web Standards make it the most portable starting point. |
| 2026-02-21 | `cluster-whisperer serve` subcommand over new bin entry | Matches existing Commander.js pattern. Single binary, multiple modes. |
| 2026-02-21 | No authentication | Matches controller contract (no auth headers). Out of scope per k8s-vectordb-sync PRD #1 M3. Can be added later. |
| 2026-02-21 | Reuse existing pipeline functions | Thin wrapper pattern — endpoint does no business logic. Same functions the CLI `sync-instances` command uses. |
| 2026-02-22 | `strict: false` on Hono app | Tolerates trailing slashes on probe URLs — standard for REST APIs and Kubernetes health checks. |
| 2026-02-22 | `vectorStore.initialize()` as readiness check | Idempotent (getOrCreateCollection). Avoids adding a new `ping()` method to the VectorStore interface for M1. |
| 2026-02-22 | Dependency injection via `createApp({ vectorStore })` | Factory pattern makes the app testable via `app.request()` without starting a real server or needing ChromaDB. |
| 2026-02-23 | `keywordSearch` over `search` for shared-collection integration tests | Deterministic substring matching avoids flaky failures when concurrent test suites write semantically similar documents to the same ChromaDB collection. |
| 2026-02-23 | `.nullable().transform()` on upserts/deletes arrays | Go nil slices serialize as JSON `null`. Same pattern already used for labels/annotations. Discovered during E2E when controller payloads returned 400. |

---

## Progress Log

| Date | Milestone | Summary |
|------|-----------|---------|
| 2026-02-22 | M1 complete | HTTP server foundation: Hono app with `/healthz` and `/readyz` probes, `cluster-whisperer serve` CLI subcommand with `--port` and `--chroma-url` options, 6 unit tests via `app.request()`, SIGTERM graceful shutdown. |
| 2026-02-22 | M2 complete | Sync endpoint upserts: Zod schema in `src/api/schemas/sync-payload.ts`, route handler in `src/api/routes/instances.ts` using `@hono/zod-validator` middleware, wired through `storeInstances()` pipeline. 27 new tests (16 schema + 11 route). Deletes accepted by schema but not processed until M3. |
| 2026-02-22 | M3 complete | Sync endpoint deletes: added `vectorStore.delete("instances", ids)` call before upserts in route handler. Empty deletes array skipped (no DB call). Mixed payloads process deletes first, then upserts. 7 new tests replacing 1 M2 passthrough test (17 route tests total, 223 suite-wide). |
| 2026-02-23 | M4 complete | Error handling edge cases: verified all 5 scenarios covered by M1-M3 implementation. Added 2 new tests — malformed JSON body (raw `{broken json` → 400) and large payload (100 upserts + 50 deletes → 200). 225 tests suite-wide (19 route tests). |
| 2026-02-23 | M5 complete | Contract integration tests in `src/api/routes/instances.integration.test.ts`: 12 tests against real ChromaDB + Voyage AI verifying upserts land in DB, deletes remove from DB, mixed payloads, empty payloads, validation errors, and response code contract matching controller expectations. Fixed pre-existing flaky orchestrator test in `instance-storage.integration.test.ts` (semantic search → keywordSearch). 276 tests suite-wide. |
| 2026-02-23 | M6 complete | End-to-end validation against real Kind cluster (spider-rainbows) with k8s-vectordb-sync controller. Fixed Go nil slice interop bug (null upserts/deletes arrays → 400). Controller synced 868 instances to ChromaDB. Verified upserts, deletes (created/deleted e2e-delete-test pod), and semantic search via agent. Documented push-based sync in `docs/resource-instance-sync.md`. 229 unit tests passing, 2 new null-array tests. |
