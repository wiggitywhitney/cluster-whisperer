# Resource Instance Sync

This document explains how cluster-whisperer discovers what's currently running in a Kubernetes cluster and makes that knowledge searchable.

---

## The Problem

The capability inference pipeline (see [capability-inference-pipeline.md](./capability-inference-pipeline.md)) tells the agent what resource *types* are available — "this cluster can run SQL databases, Ingresses, and Deployments." But when a developer asks "what databases are running?", the agent needs to know about actual *instances*: the specific nginx Deployment in `default`, the postgres StatefulSet in `production`, the SQL claim called `my-app-db`.

The agent already has kubectl tools for querying instances at runtime, but it doesn't scale when the developer doesn't know which resource types to look for. Pre-indexing instance metadata in the vector database lets the agent search across all resource types in a single query.

## The Solution

The resource instance sync pipeline discovers running Kubernetes objects, extracts lightweight metadata, and stores it in the vector database for search.

```text
kubectl api-resources → list of resource types
        |
        v
kubectl get <type> -A -o json → instances per type
        |
        v
   Extract metadata (name, namespace, kind, labels, annotations)
        |
        v
   Store in vector database as searchable documents
        |
        v
   Agent can now find running resources by meaning
```

No LLM calls are needed — instance sync is purely mechanical (enumerate, extract, store). This makes it faster and cheaper than capability inference.

## Running the Pipeline

### Prerequisites

1. **Kubernetes cluster access** — a valid kubeconfig pointing at the target cluster
2. **Chroma server running** — the vector database backend
3. **API key** — `VOYAGE_API_KEY` (for embeddings). No `ANTHROPIC_API_KEY` needed.

### Start Chroma

```bash
chroma run --path ./chroma-data
```

### Run the Sync

```bash
# Set the embedding API key (via vals or direct export)
export VOYAGE_API_KEY=your-key

# Sync all resource instances to the vector database
npx tsx src/index.ts sync-instances

# Preview what would be synced without storing
npx tsx src/index.ts sync-instances --dry-run

# Use a different Chroma server
npx tsx src/index.ts sync-instances --chroma-url http://chroma.example.com:8000
```

### What Happens During a Sync

1. **Discovery** — runs `kubectl api-resources -o wide` to list all resource types, filters out low-value resources (Events, Leases, EndpointSlices, subresources) and resources without `list` verb. Then runs `kubectl get <type> -A -o json` for each remaining type to enumerate instances.

2. **Stale cleanup** — compares the set of currently discovered instance IDs against what's already in the vector database. Any document in the DB whose ID doesn't appear in the discovered set is deleted. This handles resources that were removed from the cluster since the last sync.

3. **Storage** — converts each instance into a vector database document with embedding text and metadata, then upserts into the `instances` collection via the VectorStore interface.

Progress is logged as the pipeline runs:

```text
Discovering API resources...
Found 45 API resources.
After filtering: 32 resource types (removed 13).
Listing instances (1 of 32): deployments.apps
Listing instances (2 of 32): services
...
Discovery complete: 87 instances across 32 resource types.
Storing 87 resource instances in vector database...
Storage complete: 87 instances stored in "instances" collection.
Sync complete: 87 discovered, 87 stored, 0 deleted.
```

### Re-running

The sync uses upsert — re-running is safe and updates existing entries. Every sync processes all resources and cleans up stale entries. A full sync is fast since there's no LLM inference step; the bottleneck is kubectl calls and embedding API requests.

## Push-Based Sync via HTTP Endpoint

The `sync-instances` CLI command is a pull-based approach: cluster-whisperer runs kubectl internally to discover resources. The HTTP endpoint provides a push-based alternative: an external controller watches the cluster and pushes changes as they happen.

### How It Works

The [k8s-vectordb-sync](https://github.com/wiggitywhitney/k8s-vectordb-sync) controller watches a Kubernetes cluster for resource changes and pushes batched instance metadata over HTTP. Cluster-whisperer receives these payloads at `POST /api/v1/instances/sync` and stores them using the same pipeline functions as the CLI command.

```text
k8s-vectordb-sync controller (watches cluster)
        |
        | POST /api/v1/instances/sync
        v
cluster-whisperer serve (Hono HTTP server)
        |
        v
   Zod validation → instanceToDocument() → storeInstances()
        |
        v
   ChromaDB (instances collection)
```

### Running the HTTP Server

```bash
# Start ChromaDB
docker start chromadb  # or: docker run -d --name chromadb -p 8000:8000 chromadb/chroma:latest

# Start the HTTP server (vals injects VOYAGE_API_KEY)
vals exec -f .vals.yaml -- npx tsx src/index.ts serve --port 3000 --chroma-url http://localhost:8000
```

The server exposes these routes:

| Route | Method | Purpose |
|-------|--------|---------|
| `/healthz` | GET | Liveness probe (always 200) |
| `/readyz` | GET | Readiness probe (200 when ChromaDB is reachable) |
| `/api/v1/instances/sync` | POST | Receive batched instance upserts and deletes |
| `/api/v1/capabilities/scan` | POST | Trigger capability inference for specific CRDs (optional — see below) |

The capabilities route is optionally mounted. When the server is started with `ANTHROPIC_API_KEY` and `VOYAGE_API_KEY` available, it enables capability scanning for CRD changes alongside instance sync. See [capability-inference-pipeline.md](./capability-inference-pipeline.md) for details on the capability scan endpoint, payload format, and async processing model.

### Running the Controller

```bash
# In the k8s-vectordb-sync repo (uses current kubeconfig context)
REST_ENDPOINT=http://localhost:3000/api/v1/instances/sync make run
```

The controller discovers all watchable resource types, starts informers, debounces changes, and flushes batches to the endpoint. On startup, all existing resources are synced. After that, only changes are pushed.

The controller also detects CRD changes (new CRDs installed, existing CRDs removed). When CRD events occur, it POSTs to `/api/v1/capabilities/scan` to trigger capability inference for the new resource types. This keeps both the instances collection (what's running) and the capabilities collection (what's possible) up to date automatically.

### Payload Format

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
      "labels": { "app": "nginx" },
      "annotations": null,
      "createdAt": "2026-01-17T21:51:56Z"
    }
  ],
  "deletes": ["default/apps/v1/Deployment/old-service"]
}
```

Both `upserts` and `deletes` can be `null` (Go nil slices serialize as JSON null) or empty arrays. The Zod schema handles both cases.

### Response Codes

| Code | Meaning | Controller Behavior |
|------|---------|-------------------|
| 200 | Success | Moves on |
| 4xx | Bad request (validation failure) | Does not retry |
| 5xx | Transient failure (ChromaDB down) | Retries with exponential backoff |

### Pull vs Push Comparison

| Aspect | `sync-instances` (pull) | `serve` endpoint (push) |
|--------|------------------------|------------------------|
| Trigger | Manual CLI run | Automatic on resource changes |
| Latency | Minutes (full scan each time) | Seconds (debounced incremental) |
| Stale cleanup | Built-in (compares discovered vs stored) | Controller sends deletes |
| Dependencies | kubectl access | k8s-vectordb-sync controller |
| Use case | One-off sync, development | Continuous sync, production |

## What Gets Stored

### Instance Data Structure

Each running resource produces one `ResourceInstance`:

```typescript
interface ResourceInstance {
  id: string;           // "default/apps/v1/Deployment/nginx"
  namespace: string;    // "default" (or "_cluster" for cluster-scoped)
  name: string;         // "nginx"
  kind: string;         // "Deployment"
  apiVersion: string;   // "apps/v1"
  apiGroup: string;     // "apps"
  labels: Record<string, string>;      // { app: "nginx", tier: "frontend" }
  annotations: Record<string, string>; // { description: "Web server for HTTP traffic" }
  createdAt: string;    // "2026-01-15T10:00:00Z"
}
```

Only description-like annotations are kept (keys that are `description` or end with `/description`). Operational annotations (checksums, revision hashes) are filtered out.

**Not synced**: spec, status, managedFields. These are fetched on-demand via kubectl tools when the agent needs details about a specific instance.

### Embedding Text

The text that gets vectorized for semantic search is pipe-delimited:

```text
Deployment nginx | namespace: default | apiVersion: apps/v1 | labels: app=nginx, tier=frontend | Web server for handling HTTP traffic
```

This format puts the primary identifiers first (kind + name), followed by contextual metadata (namespace, API version, labels) and any description annotations for semantic depth.

### Metadata

Each document stores metadata for exact-match filtering:

| Field | Example | Use |
|-------|---------|-----|
| `namespace` | `default` | Filter by namespace |
| `name` | `nginx` | Filter by resource name |
| `kind` | `Deployment` | Filter by resource kind |
| `apiVersion` | `apps/v1` | Full API version |
| `apiGroup` | `apps` | Filter by API group |
| `labels` | `app=nginx,tier=frontend` | Comma-separated key=value pairs |
| `source` | `resource-sync` | Identifies how the document was created |

## The Semantic Bridge

The real power comes from combining capabilities and instances. The two collections work together in what we call the "semantic bridge" pattern:

```text
User asks: "What databases are running?"
        |
        v
1. Search CAPABILITIES for "database"
   → finds: StatefulSet (database, persistent-storage)
   → finds: SQL (managed-database, postgresql, mysql)
        |
        v
2. Extract kinds from results: [StatefulSet, SQL]
        |
        v
3. Filter INSTANCES by those kinds
   → finds: postgres-primary (StatefulSet in production)
   → finds: my-app-db (SQL in production)
        |
        v
4. Agent synthesizes: "You have 2 databases running:
   a PostgreSQL StatefulSet and a managed SQL database."
```

Step 1 uses semantic search in the capabilities collection to understand *what types of resources* match the user's intent. Step 3 uses metadata filtering in the instances collection to find *actual running objects* of those types.

This pattern works because:
- Capabilities contain LLM-inferred descriptions that map natural language to resource types
- Instances contain lightweight metadata that enables fast filtering by kind, namespace, and labels
- The agent orchestrates both searches to bridge the gap between "what does the user mean?" and "what's actually running?"

## Architecture

```text
src/pipeline/
├── types.ts                  # ResourceInstance, InstanceDiscoveryOptions
├── instance-discovery.ts     # M1: kubectl api-resources + kubectl get per type
├── instance-storage.ts       # M2: VectorStore document construction and upsert
├── instance-runner.ts        # M3: Orchestrates discover → delete stale → store
└── index.ts                  # Barrel exports
```

All pipeline stages use dependency injection for testability — the kubectl executor and vector store are injectable, so unit tests can mock system boundaries while integration tests use real services.

## Comparison with Capability Inference

| Aspect | Capability Inference | Instance Sync |
|--------|---------------------|---------------|
| What it stores | Resource *types* (one per kind) | Resource *instances* (one per object) |
| LLM required | Yes (schema analysis via Haiku) | No (pure metadata extraction) |
| API keys needed | `ANTHROPIC_API_KEY` + `VOYAGE_API_KEY` | `VOYAGE_API_KEY` only |
| Collection name | `capabilities` | `instances` |
| CLI command | `sync` | `sync-instances` |
| Sync speed | Minutes (LLM is the bottleneck) | Seconds (kubectl + embeddings only) |
| Stale cleanup | No (resource types are stable) | Yes (instances come and go) |
| Example query | "How do I deploy a database?" | "What databases are running?" |
