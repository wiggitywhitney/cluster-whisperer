# Vector Database Research Findings

Research for PRD #7: Vector Database Integration (Chroma)

---

## 1. Chroma: Current State and Capabilities

### Version and Maturity

**Current version: v1.5.0** (released February 2026). Chroma reached 1.0 in March 2025 (a full Rust rewrite), and has been releasing roughly monthly since. The JS/TS SDK is at v3.3.0 with ~53K weekly npm downloads. The project is stable and actively maintained.

Key breaking changes at v1.0.0:
- Built-in authentication removed (use external auth)
- Server configuration moved to YAML files
- Docker data path changed from `/chroma/chroma` to `/data`

### Architecture

Chroma has five core components: Gateway (auth, routing), Log (write-ahead log), Query Executor (reads), Compactor (index building), and System Database (cluster state).

Data model hierarchy: **Tenants** → **Databases** → **Collections** → Documents with IDs, embeddings, optional metadata, and optional documents (raw text).

### Deployment Modes

| Mode | Description | Best For |
|------|-------------|----------|
| **Ephemeral** | In-memory, no persistence | Testing, throwaway experiments |
| **Persistent** | Local file storage (SQLite-backed) | Development, single-user apps |
| **Client-Server** | HTTP server, separate process | Multi-process, shared access |
| **Cloud** | Managed serverless | Production, team use |

**Important for TypeScript**: The Python SDK supports ephemeral and persistent client modes (in-process, no server needed). The **TypeScript SDK does not** - it always requires a running Chroma server. So for our TypeScript project, we must run `chroma run --path ./data` locally or use Docker (`docker run -p 8000:8000 chromadb/chroma`). This is a minor inconvenience but not a blocker.

For our use case (KubeCon demo, learning-focused), **client-server with a local Chroma process** is the right approach. Run `chroma run` locally, connect from our TypeScript code. Data persists in the server's data directory. Simple enough, and mirrors how it would work in production.

### Embedding Functions

Chroma supports 11+ embedding providers. Default is `all-MiniLM-L6-v2` (sentence-transformers, runs locally, no API key needed).

TypeScript SDK requires separate packages per provider:
- `@chroma-core/default-embed` - Default local model
- `@chroma-core/openai` - OpenAI embeddings
- Custom functions via `EmbeddingFunction` interface

### Query Capabilities

- **Similarity search**: Vector distance (cosine, L2, inner product)
- **Metadata filtering**: `where` clauses with operators (`$eq`, `$ne`, `$gt`, `$lt`, `$in`, `$nin`)
- **Document filtering**: `where_document` with `$contains`, `$not_contains`
- **Full-text search**: Built-in text indexing
- **Hybrid search**: Cloud-only feature (Reciprocal Rank Fusion) - not available in self-hosted yet

### TypeScript SDK

```typescript
import { ChromaClient } from "chromadb";

const client = new ChromaClient();  // connects to localhost:8000 or use EphemeralClient()

const collection = await client.getOrCreateCollection({
  name: "k8s-resources",
  embeddingFunction: new OpenAIEmbeddingFunction({ modelName: "text-embedding-3-small" }),
});

await collection.add({
  ids: ["id1", "id2"],
  documents: ["doc text 1", "doc text 2"],
  metadatas: [{ kind: "Deployment" }, { kind: "Service" }],
});

const results = await collection.query({
  queryTexts: ["how to deploy a database"],
  nResults: 5,
  where: { kind: "CustomResourceDefinition" },
});
```

### LangChain.js Integration

Available via `@langchain/community`:
- Install: `@langchain/community` + `chromadb` as peer dependency
- Import: `import { Chroma } from "@langchain/community/vectorstores/chroma"`
- Operations: `addDocuments()`, `similaritySearch()`, `similaritySearchWithScore()`, `asRetriever()`

**Caveat**: There are reported issues with the LangChain.js + Chroma integration, particularly with empty `where: {}` clauses in newer Chroma versions. The native Chroma SDK is more reliable.

**Recommendation**: Use the native Chroma TypeScript SDK directly rather than the LangChain wrapper. This avoids the integration issues, gives us full control, and is more pedagogically clear for a teaching project. We already use LangChain for the agent loop - we do not need it for vector store operations too.

---

## 2. Embedding Models

### Options for Technical Documentation

| Model | Provider | Dimensions | Runs Locally | Cost | Notes |
|-------|----------|-----------|-------------|------|-------|
| `all-MiniLM-L6-v2` | Sentence Transformers | 384 | Yes | Free | Chroma default, decent quality |
| `text-embedding-3-small` | OpenAI | 1536 | No | $0.02/1M tokens | Best quality-to-cost ratio |
| `text-embedding-3-large` | OpenAI | 3072 | No | $0.13/1M tokens | Highest quality |
| `nomic-embed-text` | Nomic | 768 | Yes (Ollama) | Free | Good open-source option |

### Anthropic Embedding Status

Anthropic does not offer an embedding API. Their official recommendation is **Voyage AI** (now part of MongoDB) - the Anthropic docs page on embeddings explicitly points to Voyage AI as a partner. Voyage's `voyage-code-3` model outperforms OpenAI on code retrieval benchmarks by ~14%.

However, for our project, Voyage AI adds another API dependency for marginal gain. OpenAI embeddings are simpler and better documented in the Chroma/LangChain ecosystem.

### What Matters Most (Ranking)

Recent research (2025) shows this ranking for retrieval quality impact:

1. **What you embed** (most important) - natural language descriptions vs raw YAML
2. **Chunking/document structure** - how CRDs are represented as documents
3. **Metadata and filtering** - using kind, group, version as filters
4. **Embedding model** (least important) - any reasonable model works

The embedding model is the decision people agonize over most, but research consistently shows it has the least marginal impact. Spending time on good document representation yields far more retrieval quality than upgrading between models.

### Recommendation

> **Superseded by Decision 3**: Final choice is Voyage AI `voyage-4`. See the Decisions section below.

**Start with OpenAI `text-embedding-3-small`** for these reasons:
- Best retrieval quality for the cost ($0.02/1M tokens)
- Well-tested with Chroma
- Simple API (we already manage API keys via vals)
- The cost is negligible for our data volumes (a few hundred CRDs = pennies)
- Easy to swap later if needed

**Zero-dependency alternative**: Chroma's built-in default (`all-MiniLM-L6-v2`) works with zero config and no API keys. Lower quality (384 dimensions, MTEB ~49 vs ~62) but adequate for a demo.

For a production system or offline use, `nomic-embed-text` via Ollama would be the local alternative. But for a KubeCon demo, simplicity and quality matter more than avoiding an API call.

---

## 3. Viktor's Controller Architecture (Critical Assessment)

### Architecture Overview

Viktor uses a **two-repository, two-deployment** approach:

```text
[K8s Cluster]
  └── dot-ai-controller pod (Go/Kubebuilder)
        ├── Watches ALL resources via dynamic informers
        ├── Debounces changes (10s window)
        └── POSTs batches to MCP REST endpoint
              │
              ▼
[MCP Server / dot-ai] (TypeScript)
  ├── REST API: POST /api/v1/resources/sync
  ├── Generates embeddings (OpenAI/Google/Bedrock)
  └── Stores in Qdrant (vector database)
```

### Controller Details

**Where it runs**: In-cluster as a Kubernetes pod, deployed via Helm chart. It is a full **Kubebuilder operator** with its own CRD (`ResourceSyncConfig`) for configuration.

**What it watches**: Everything. Uses the Kubernetes Discovery API to find all resource types, then creates dynamic informers for each. Skips high-churn resources (Events, Leases, EndpointSlices, subresources).

**What gets embedded**: Metadata only - kind, name, namespace, apiVersion, labels, selected annotations. Not specs or status. The embedding text is a pipe-separated string:

```text
Deployment my-app | namespace: default | apiVersion: apps/v1 | ...
```

**Sync strategy**: Hybrid event-driven + periodic resync:
1. Informers detect changes in real-time
2. Changes go into a debounce buffer (10s default, last-state-wins dedup)
3. Batched HTTP POST to MCP server
4. Full resync every 60 minutes for eventual consistency

**Complexity**: ~1,500 lines of Go (controller) + ~2,000 lines of TypeScript (sync handler, embedding, storage). 39 files in the controller directory alone.

### What We Should Learn From

**Good patterns to adopt:**
- Event-driven sync with debounce batching
- Last-state-wins deduplication (only embed the final state, not intermediate changes)
- Periodic full resync as a safety net
- Diff-and-sync: compare incoming resources against existing DB, only update what changed
- Separate semantic search tool + filter-based query tool for the agent
- Hybrid search (semantic + keyword with combined scoring)

**What we should NOT copy:**
- **Full Kubebuilder operator** - This is production-grade infrastructure. For a learning project, a simpler approach (a TypeScript script using `kubectl` or the K8s JS client) is more appropriate and pedagogically clearer.
- **Watching ALL resources** - Overkill for our demo. We should start with a curated set (CRDs, API groups) that demonstrates the concept.
- **Two separate repositories** - For a teaching project, keep everything in one codebase.
- **REST API between controller and agent** - Unnecessary complexity when both are TypeScript. Direct function calls are simpler.
- **Metadata-only embeddings** - Viktor skips specs, which limits semantic search quality. For CRDs, the spec schema (field names, descriptions) is exactly what helps answer "how do I deploy a database?". We should consider embedding more than just metadata.
- **Multiple Qdrant collections** - Viktor has separate collections for resources, capabilities, patterns, policies, and knowledge. One collection is sufficient for our POC.

### Key Insight: Viktor's Controller is Substantial

The controller is **not** a small add-on - it is a significant engineering effort (Go operator, Helm chart, CRDs, RBAC, informers, debouncing, HTTP client with retries). This confirms the PRD's instinct to potentially split the work:

- **PRD #7**: Chroma setup + query tool + manual/scripted data loading
- **Separate future PRD**: K8s controller for automatic sync (if needed)

---

## 4. Controller / Sync Architecture (Question 7)

### What Needs to Be Synced

For our use case (helping developers discover relevant CRDs/APIs), the key data is:

1. **CRD definitions** - What custom resources exist, what they do, what fields they have
2. **API groups and resources** - What's available in the cluster's API surface
3. **Resource instances** (optional) - What's actually deployed, for context

### Where Should the Controller Run?

| Option | Pros | Cons |
|--------|------|------|
| **In-cluster pod** (Viktor's approach) | Real-time events, proper RBAC, production-ready | Heavy infrastructure, Go operator, separate deployment |
| **CLI script (out-of-cluster)** | Simple, uses existing kubeconfig, easy to understand | Manual trigger, not real-time |
| **Part of agent process** | Single deployment, simplest architecture | Agent must have cluster access, couples concerns |
| **Startup sync in MCP server** | Loads on server start, always fresh | Slow startup, no incremental updates |

### Recommendation for Our Project

**Start with a CLI sync script** that:
1. Runs `kubectl` (or K8s JS client) to discover CRDs and API resources
2. Extracts relevant data (names, descriptions, spec schemas, API groups)
3. Formats documents for embedding
4. Loads into Chroma

This is invoked manually or as a build step. It keeps the architecture dead simple for teaching, and can be evolved into an automated controller later if needed.

The sync script should live alongside the agent code (not a separate repo), and should be a tool that someone following the KubeCon talk can run themselves.

---

## 5. Collection Structure and Data Schema

### Recommended Collection Design

**Single collection: `k8s-resources`** with **cosine** distance (Chroma defaults to L2, but cosine is standard for text embeddings). The distance metric cannot be changed after creation.

Each document represents one Kubernetes resource type (not instance):

```typescript
{
  id: "apps/v1/Deployment",              // API group/version/kind
  document: "Deployment (apps/v1) - ...", // Natural language description for embedding
  metadata: {
    kind: "Deployment",
    apiVersion: "apps/v1",
    apiGroup: "apps",
    scope: "Namespaced",                  // or "Cluster"
    isCRD: false,
    // For CRDs, additional metadata:
    crdGroup: "crossplane.io",
    crdDescription: "...",
  }
}
```

### What to Embed (Document Text)

For each resource type, construct a natural language description:

```text
Deployment (apps/v1) - Manages a set of replica Pods.
Use for running stateless applications.
Supports rolling updates and rollbacks.
Spec fields: replicas, selector, template, strategy, minReadySeconds...
```

For CRDs with descriptions (many Crossplane CRDs have rich descriptions):

```text
Provider (pkg.crossplane.io/v1) - A Crossplane Provider installs
a controller that manages external resources.
Use when you need to add cloud provider support.
Spec fields: package, controllerConfigRef, revisionActivationPolicy...
```

### Chunking Strategy

For most K8s resources, a single document per resource type is fine (they are not long enough to need chunking). If CRD descriptions + spec fields exceed ~500 tokens, chunk by section (description, spec fields, status fields).

---

## 6. Decisions

All decisions resolved on 2026-02-11. See `docs/viktors-pipeline-assessment.md` for the full analysis of Viktor's architecture that informed these decisions.

### Decision 1: Controller / sync approach ✅

**Decided: Build our own lightweight pipeline (was Option B/C hybrid)**

We will build a lightweight TypeScript pipeline that runs as a CLI tool or startup script, not a full Kubernetes controller. This covers two separate concerns split into their own PRDs:
- **PRD #25** (Capability Inference Pipeline): Discovers CRDs, runs `kubectl explain`, sends schemas to an LLM, stores structured capability descriptions in the vector DB.
- **PRD #26** (Resource Instance Sync): Discovers resource instances, extracts metadata, stores in the vector DB.

**Why not Viktor's controller**: Viktor's controller targets Qdrant. We need Chroma first. His controller is also a full Go Kubebuilder operator (~1,500 lines) which is over-engineered for a teaching demo. We'll install Viktor's full stack later for the Qdrant path of the KubeCon presentation.

**Why not just a sync script**: The capability inference system (which is what powers Act 2 of the demo) requires LLM analysis of CRD schemas — it's more than a simple sync. It's a pipeline: discover → analyze → store.

### Decision 2: What to embed ✅

**Decided: Two types of data, handled by separate PRDs**

1. **Capability descriptions** (PRD #25): AI-generated semantic descriptions of what each resource *type* does. One document per resource type. The LLM analyzes `kubectl explain` output and produces structured capability data (capabilities, providers, complexity, description, useCase). The embedded text is **natural language prose with keywords preserved** — not pipe-separated metadata, but also not dropping the capability tags. Example:

   ```text
   SQL (devopstoolkit.live/v1beta1) — A managed database solution supporting
   PostgreSQL and MySQL across Azure, GCP, and AWS. Use for simple database
   deployment without infrastructure complexity. Capabilities: postgresql,
   mysql, database, multi-cloud. Complexity: low.
   ```

2. **Resource instance metadata** (PRD #26): Instance-level metadata for running resources (name, namespace, kind, apiVersion, labels, description annotations). One document per instance. The embedded text is pipe-separated identity metadata (similar to Viktor's approach).

**Key insight from research**: Viktor's system has these as two separate Qdrant collections (`capabilities` and `resources`) populated by two separate mechanisms. The capabilities collection is what powers semantic discovery ("how do I deploy a database?"). The resources collection is what powers instance lookup ("what databases are running?"). We're following the same pattern.

### Decision 3: Embedding model ✅

**Decided: Voyage AI `voyage-4`**

$0.06/1M tokens with 200M tokens free per account — effectively free at our data volumes (a few hundred CRDs = a few hundred thousand tokens). Voyage AI is Anthropic's official embedding partner, keeping us in the Anthropic ecosystem. Good quality (better than OpenAI's small model) at no cost for our use case. The embedding model lives behind the vector DB interface so it can be swapped independently.

### Decision 4: Chroma SDK approach ✅

**Decided: Native Chroma TypeScript SDK (re-evaluate at implementation time)**

Direct API, full control, fewer dependencies. The LangChain.js + Chroma integration has active bugs as of early 2026: Chroma 1.x (Rust rewrite) broke the LangChain wrapper, empty `where: {}` clauses cause errors, and the wrapper forces a dependency on `@chroma-core/default-embed` even when using your own embeddings.

**Note**: Re-evaluate this decision at implementation time (PRD #7, M2). The LangChain wrapper bugs may be fixed by then, and our abstraction layer design might naturally align with LangChain's `VectorStore` interface. The native SDK is the safer choice today, but this isn't locked in.

### Decision 5: Collection structure ✅

**Decided: Two collections (capabilities + resource instances)**

One collection for capability descriptions (type-level semantic data from PRD #25), one for resource instances (runtime metadata from PRD #26). This matches Viktor's design and keeps the two data types cleanly separated — they have different document shapes, different search patterns, and different update frequencies.

**Why not single collection**: Searching "database" in a single collection would return a mix of capability descriptions and instance metadata. The agent would have to filter every time, and the embedding space would be muddled. Separate collections mean each search is focused and the agent deliberately chooses which collection to query — the "semantic bridge" pattern becomes a clear two-step process.

**Why not 4-5 collections** (like Viktor): Overkill for our POC. Two is the right number — capabilities and instances cover our use case.

### Decision 6: Document granularity ✅

**Decided: One per type (capabilities collection) + one per instance (instances collection)**

- **Capabilities collection** (PRD #25): One document per resource *type* (e.g., one for "Deployment", one for "SQLClaim"). Fewer documents, each semantically rich.
- **Resource instances collection** (PRD #26): One document per resource *instance* (e.g., one for each running Deployment). More documents, identity metadata.

Each lives in its own collection (per Decision 5). This matches Viktor's approach — his `capabilities` and `resources` collections follow the same granularity pattern.

### Decision 7: PRD scope ✅

**Decided: Three-way split**

- **PRD #7**: Vector database setup (Chroma), vector-DB-agnostic interface, search/query tools for the agent
- **PRD #25**: Capability inference pipeline (CRD schemas → LLM → vector DB)
- **PRD #26**: Resource instance sync (K8s metadata → vector DB)

Implementation order: #7 first (foundation), then #25 (powers Act 2), then #26 (lower priority).

All data loading code (PRDs #25 and #26) writes to a vector-DB-agnostic interface defined in PRD #7, so we can swap Chroma for Qdrant later without changing the pipeline code.

### Decision 8: Distance metric ✅

**Decided: Cosine**

Standard for text embeddings, ignores vector magnitude. Must be set at collection creation time — cannot be changed after. Chroma defaults to L2 (Euclidean), so we must explicitly set cosine when creating the collection.

---

## Sources

- [Chroma Documentation](https://docs.trychroma.com/)
- [Chroma Collections Guide](https://docs.trychroma.com/docs/collections/manage-collections)
- [Chroma Embedding Functions](https://docs.trychroma.com/docs/embeddings/embedding-functions)
- [Chroma Architecture](https://docs.trychroma.com/docs/overview/architecture)
- [Chroma Migration Guide](https://docs.trychroma.com/docs/overview/migration)
- [Chroma Cloud](https://docs.trychroma.com/cloud/getting-started)
- [LangChain.js Chroma Integration](https://docs.langchain.com/oss/javascript/integrations/vectorstores/chroma)
- [Viktor's dot-ai](https://github.com/vfarcic/dot-ai) (TypeScript MCP server)
- [Viktor's dot-ai-controller](https://github.com/vfarcic/dot-ai-controller) (Go K8s operator)
