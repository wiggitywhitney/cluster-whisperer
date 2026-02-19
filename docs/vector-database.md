# Vector Database Concepts

This document explains how cluster-whisperer uses a vector database to help developers discover Kubernetes resources by meaning, not just by name.

---

## The Problem

Kubernetes clusters often have dozens or hundreds of resource types — built-in kinds like Deployments and Services, plus custom resources (CRDs) like SQLClaims or Crossplane Providers. When a developer asks "how do I deploy a database?", the agent needs to search all these resource types and find the relevant ones.

Traditional search (exact keyword matching) doesn't work well here. The developer said "database" but the relevant CRD might be called "SQLClaim" or "PostgreSQLInstance." We need search that understands meaning.

## What Is a Vector Database?

A vector database stores data as arrays of numbers (vectors) and finds items by mathematical similarity instead of exact matching.

The key idea: **text with similar meaning produces similar vectors.** The sentence "a managed database solution" and the query "how do I deploy a database?" would produce vectors that are close together, even though they share few exact words.

### How It Works

```text
1. STORE: "SQLClaim — A managed database solution supporting PostgreSQL"
                ↓ embedding model
         [0.012, -0.034, 0.089, ...]  (1024 numbers)
                ↓
         stored in vector database

2. SEARCH: "how do I deploy a database?"
                ↓ embedding model
         [0.015, -0.029, 0.091, ...]  (1024 numbers)
                ↓ compare vectors
         SQLClaim is the closest match → returned as result
```

## Embeddings

An **embedding** is the process of converting text into a vector (array of numbers). The model that does this is called an **embedding model**.

We use **Voyage AI's `voyage-4` model**, which produces 1024-dimensional vectors. Voyage AI is Anthropic's recommended embedding provider.

### Why 1024 Numbers?

Each number represents one dimension of meaning. More dimensions capture more nuance, but cost more to store and compare. 1024 is a good balance — enough to distinguish "database deployment" from "network ingress" while staying fast.

### Why Not Use Claude for Embeddings?

Anthropic doesn't offer an embedding API. Embedding models are a different type of model than chat models — they're optimized for producing vectors, not generating text. Voyage AI specializes in this.

## Cosine Distance

When comparing two vectors, we need a way to measure "how similar are these?" We use **cosine distance**, which measures the angle between two vectors:

- **0.0** = identical direction (same meaning)
- **1.0** = perpendicular (unrelated)
- **2.0** = opposite direction

Cosine distance ignores vector length (magnitude) and only cares about direction. This matters because different-length texts might have vectors of different magnitudes, but we want to compare their meaning, not their length.

### Why Not Euclidean (L2) Distance?

Euclidean distance measures the straight-line distance between two points. It's sensitive to vector magnitude — a longer document might have a larger vector, making it seem "farther" from a short query even if the meaning is similar. Cosine distance avoids this problem.

## Our Two-Collection Design

We use two separate collections (like two separate tables):

### 1. Capabilities Collection

**What it stores:** One document per Kubernetes resource *type* (e.g., Deployment, Instance.rds.aws.upbound.io).

**What's in each document:** An AI-generated description of what the resource does, its capabilities, providers, complexity, and when to use it. See `docs/capability-inference-pipeline.md` for the full data structure.

**When it's searched:** "How do I deploy a database?" → semantic search finds `instances.rds.aws.upbound.io` because its description mentions managed database, MySQL, PostgreSQL.

**Populated by:** The `sync` command (`npx tsx src/index.ts sync`). See `docs/capability-inference-pipeline.md` for setup and usage.

### 2. Instances Collection

**What it stores:** One document per running Kubernetes resource *instance* (e.g., the actual `my-database` SQLClaim in the `production` namespace).

**What's in each document:** Identity metadata — name, namespace, kind, apiVersion, labels.

**When it's searched:** "What databases are running?" → finds all SQLClaim instances.

**Populated by:** PRD #26 (Resource Instance Sync)

### Why Two Collections?

Searching "database" in a single collection would return a mix of capability descriptions and instance metadata. The agent would have to filter every time. Separate collections mean each search is focused — the agent deliberately chooses *which* collection to query.

This enables the **semantic bridge** pattern: semantic search finds resource *types* (capabilities), then a filter query finds *instances* of those types.

## The Interface Pattern

The codebase has an abstraction layer so the vector database can be swapped:

```text
PRDs #25 and #26          →    VectorStore interface    →    ChromaBackend
(data loading pipelines)       (types.ts)                    (chroma-backend.ts)
                                                              ↓
Agent search tools         →    VectorStore interface    →    (future: QdrantBackend)
(M3)                            (types.ts)
```

The `VectorStore` interface has four operations:
- **initialize()** — create a collection (idempotent)
- **store()** — add documents (text + metadata)
- **search()** — find similar documents by natural language
- **delete()** — remove documents by ID

Everything codes against this interface. The Chroma backend implements it using the Chroma SDK. A future Qdrant backend would implement the same interface. The pipeline code doesn't change.

## Running Chroma Locally

Chroma requires a running server (the TypeScript SDK doesn't support in-process mode):

```bash
# Install Chroma (Python package — the server is Python, the client is TypeScript)
pip install chromadb

# Start the server with persistent storage
chroma run --path ./data

# Or use Docker
docker run -p 8000:8000 chromadb/chroma
```

The server runs on `http://localhost:8000` by default. Override with the `CHROMA_URL` environment variable.

## Configuration

### Secrets

The Voyage AI API key is managed through vals (GCP Secrets Manager):

```bash
# Run with secrets injected
vals exec -i -f .vals.yaml -- node dist/your-script.js
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `VOYAGE_API_KEY` | (required) | Voyage AI API key for embeddings |
| `CHROMA_URL` | `http://localhost:8000` | Chroma server URL |

## Real Usage Patterns

These examples show how the agent searches capabilities after running `sync` on a cluster with Crossplane AWS providers.

### Semantic Search — Find by Meaning

The agent asks: "what resources handle databases?"

```text
vector_search(collection: "capabilities", query: "managed database")
```

Returns ranked results by semantic similarity:
1. `instances.rds.aws.upbound.io` (distance: 0.35) — MySQL, PostgreSQL, MariaDB, Oracle, SQL Server
2. `clusterinstances.rds.aws.upbound.io` (distance: 0.35) — Aurora cluster instances
3. `clusters.docdb.aws.upbound.io` (distance: 0.38) — MongoDB-compatible DocumentDB
4. `clusters.neptune.aws.upbound.io` (distance: 0.40) — Graph database

The query "managed database" found RDS, DocumentDB, and Neptune resources — none of which have "database" in their Kubernetes resource name.

### Keyword Search — Find by Exact Term

The agent knows a specific term to look for:

```text
vector_search(collection: "capabilities", keyword: "postgresql")
```

Returns documents whose text contains the substring "postgresql" — fast, no embedding API call needed. Finds RDS instances and cluster instances that support PostgreSQL.

### Metadata Filter — Find by Structure

The agent wants simple resources only:

```text
vector_search(collection: "capabilities", complexity: "low")
```

Returns ConfigMap, Secret, Service, Namespace, and other resources rated as low complexity by the LLM. Useful for recommending starting points to new users.

### Combined — Semantic + Filter

The agent wants database resources that are simple to configure:

```text
vector_search(collection: "capabilities", query: "database", complexity: "low")
```

Combines semantic similarity (finds database-related resources) with exact metadata filtering (only low complexity). This narrows results to approachable database options.

### Discovery → Investigation Flow

The typical agent workflow combines vector search with kubectl:

1. **Search capabilities**: `vector_search(query: "database")` → finds CRD types
2. **Check what's deployed**: `kubectl_get(resource: "instances.rds.aws.upbound.io", namespace: "all")` → finds running instances
3. **Inspect details**: `kubectl_describe(resource: "instances.rds.aws.upbound.io", name: "my-db")` → gets current state

This is the "semantic bridge" — vector search finds *what types exist*, then kubectl inspects *what's actually running*.
