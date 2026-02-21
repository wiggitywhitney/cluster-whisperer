# PRD #35: Instance Sync REST Endpoint

**Status**: Active
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

- [ ] `POST /api/v1/instances/sync` accepts the controller's JSON payload format
- [ ] Upserts flow through `instanceToDocument()` → `storeInstances()` pipeline
- [ ] Deletes remove instances from the vector DB by ID
- [ ] Returns 200 on success, 4xx on bad requests, 5xx on transient failures
- [ ] Empty payloads return 200 with no processing (defensive — controller typically skips them, but endpoint must tolerate if sent)
- [ ] `cluster-whisperer serve` starts the HTTP server on a configurable port
- [ ] `GET /healthz` returns 200 (liveness — is the process alive)
- [ ] `GET /readyz` returns 200 only when ChromaDB is reachable (readiness — can it serve traffic)
- [ ] Contract tests validate endpoint behavior matches controller expectations
- [ ] End-to-end test with k8s-vectordb-sync controller succeeds

## Milestones

- [ ] **M1**: HTTP Server Foundation
  - Install `hono`, `@hono/node-server`, `@hono/zod-validator`
  - Create `src/api/server.ts` with Hono app and probe routes
  - `GET /healthz` — liveness probe, always returns 200 if process is running
  - `GET /readyz` — readiness probe, returns 200 only when ChromaDB is reachable (lightweight ping)
  - Add `cluster-whisperer serve` subcommand to Commander.js CLI
  - Options: `--port <number>` (default: 3000), `--chroma-url <url>` (default: CHROMA_URL env or http://localhost:8000)
  - Verify server starts and both probes respond correctly

- [ ] **M2**: Sync Endpoint — Upserts
  - Create `POST /api/v1/instances/sync` route in `src/api/routes/instances.ts`
  - Define Zod schema matching the controller's payload format (upserts + deletes arrays)
  - Wire upserts through existing `instanceToDocument()` and `storeInstances()` pipeline
  - Validate with Zod, return 400 for malformed payloads
  - Return 200 on success, 500 on vector DB errors
  - Handle empty upserts array (no processing, return 200)

- [ ] **M3**: Sync Endpoint — Deletes
  - Wire deletes through `vectorStore.delete(collection, ids)`
  - Handle empty deletes array (no processing)
  - Handle mixed payloads (upserts + deletes in same request): process deletes first, then upserts. If the same ID appears in both, the upsert recreates the item.
  - Return 200 on success, 500 on vector DB errors

- [ ] **M4**: Error Handling and Edge Cases
  - Empty payload (both arrays empty or missing) returns 200
  - Malformed JSON returns 400
  - Invalid payload shape (fails Zod validation) returns 400 with error details
  - Vector DB connection failure returns 500 (controller will retry)
  - Large payloads handled correctly (controller batches, but test boundary)

- [ ] **M5**: Contract Tests
  - Unit tests for Zod schema validation (valid payloads, edge cases, malformed input)
  - Integration tests: POST with upserts → verify documents in vector DB
  - Integration tests: POST with deletes → verify documents removed from vector DB
  - Integration tests: POST with mixed upserts + deletes → verify both operations
  - Integration tests: empty payload → 200, no DB operations
  - Integration tests: malformed payload → 400
  - Integration tests: verify response codes match controller expectations (200, 4xx, 5xx)
  - These tests should mirror the k8s-vectordb-sync contract tests from the controller side

- [ ] **M6**: End-to-End Validation
  - Run `cluster-whisperer serve` against a real ChromaDB instance
  - Run k8s-vectordb-sync controller pointing at the endpoint
  - Verify instances appear in vector DB after controller push
  - Verify deleted instances are removed from vector DB
  - Verify the agent can find pushed instances via semantic search
  - Document the full setup and demo flow

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
  createdAt: z.string(),
});

const SyncPayloadSchema = z.object({
  upserts: z.array(ResourceInstanceSchema).default([]),
  deletes: z.array(z.string()).default([]),
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

---

## Progress Log

*Progress will be logged here as milestones are completed.*
