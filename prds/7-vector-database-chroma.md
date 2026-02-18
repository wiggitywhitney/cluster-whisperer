# PRD #7: Vector Database Integration (Chroma)

**Status**: Complete
**Completed**: 2026-02-18
**Created**: 2026-01-24
**GitHub Issue**: [#7](https://github.com/wiggitywhitney/cluster-whisperer/issues/7)

---

## Problem Statement

Kubernetes clusters often have dozens or hundreds of CRDs and APIs. Developers face:
- Overwhelming number of custom resources to navigate
- No easy way to discover what APIs are available
- Difficulty understanding which CRD to use for their task

The agent needs a way to help developers find relevant resources based on what they're trying to accomplish, not just what they already know to ask for.

## Solution

Set up Chroma as the vector database and define a vector-DB-agnostic interface that the rest of the system writes to. Build a semantic search tool the agent can use to query the knowledge base.

**Why vector-DB-agnostic**: The KubeCon demo presents Chroma and Qdrant as alternative choices. The data loading pipelines (PRD #25, PRD #26) should write to an interface, not directly to Chroma, so we can swap backends. This PRD implements the Chroma backend behind that interface.

**Architecture context**: This PRD is the foundation. Two other PRDs depend on it:
- **PRD #25** (Capability Inference Pipeline) — loads CRD capability descriptions into the vector DB
- **PRD #26** (Resource Instance Sync) — loads K8s resource instance metadata into the vector DB

---

## Research Findings

Research is complete. Full findings documented in `docs/vector-db-research.md`. Key decisions informed by research:

### Chroma Deployment
**Client-server with a local Chroma process.** The TypeScript SDK always requires a running Chroma server (no in-process mode like Python). Run `chroma run --path ./data` locally or use Docker. Simple enough for a demo, mirrors production patterns.

### Chroma SDK Approach
**Native Chroma TypeScript SDK** (not the LangChain wrapper). The LangChain.js + Chroma integration has active bugs as of early 2026 (Chroma 1.x broke the wrapper, empty `where: {}` errors, forced default-embed dependency). Direct SDK gives full control and is pedagogically clearer. Re-evaluate at implementation time — the bugs may be fixed by then.

### Collection Structure
**Two collections** with cosine distance: one for capability descriptions (type-level semantic data), one for resource instances (runtime metadata). Cosine is standard for text embeddings and ignores vector magnitude. The distance metric cannot be changed after collection creation. Use metadata filters to narrow queries within each collection.

### Embedding Model
**Voyage AI `voyage-4`**. $0.06/1M tokens with 200M tokens free — effectively free at our data volumes. Voyage is Anthropic's official embedding partner. The embedding model choice lives behind the interface so it can be swapped independently of the vector DB.

### Distance Metric
**Cosine.** Standard for text embeddings. Must be set at collection creation time and cannot be changed later.

### Document Granularity
**One document per resource type** (not per instance). Each document represents a Kubernetes resource kind (e.g., "Deployment", "SQLClaim") with a natural language description. Resource instances are handled separately by PRD #26.

### What Viktor Does (for reference)
Viktor uses Qdrant with a plugin architecture that isolates vector DB calls to ~4 files. His system has multiple collections (resources, capabilities, patterns, policies, knowledge). His query tools support both semantic search and filter-based queries, combined via a "semantic bridge" pattern. See `docs/viktors-pipeline-assessment.md` for full analysis.

---

## Success Criteria

- [x] Chroma running and accessible from the agent
- [x] Vector DB interface defined that other PRDs can write to
- [x] Chroma backend implements the interface
- [x] Agent has a unified search tool with semantic, keyword, and metadata filter capabilities
- [x] Documentation explains vector DB concepts and our implementation

## Milestones

- [x] **M1**: Research Phase
  - Study Chroma documentation and official examples
  - Research embedding models for technical documentation
  - Study Viktor's architecture for K8s sync patterns
  - Document findings in `docs/vector-db-research.md`
  - Decide on PRD split (controller as separate PRDs)
  - **Completed**: Research documented, decisions made, PRD split into #7, #25, #26

- [x] **M2**: Chroma Setup and Vector DB Interface
  - Install Chroma packages (`chromadb`)
  - Install embedding packages (Voyage AI `voyage-4`)
  - Define vector DB interface (store, search, delete, initialize collection)
  - Implement Chroma backend behind the interface
  - Configure Chroma connection (localhost:8000 for dev)
  - Configure embedding model behind the interface
  - Create two collections with cosine distance metric (capabilities + resource instances)
  - Manual test: can store and retrieve test documents through the interface
  - Create `docs/vector-database.md` explaining vector DB concepts
  - **Completed**: Interface defined in `src/vectorstore/types.ts`, Chroma backend in `src/vectorstore/chroma-backend.ts`, Voyage AI embeddings in `src/vectorstore/embeddings.ts`. End-to-end test passed: stored 3 docs, semantic search ranked correctly (SQL #1 for "database", Ingress #1 for "network traffic").

- [x] **M3**: Search Tool for the Agent
  - [x] Format search results for LLM consumption (`src/tools/core/format-results.ts`)
  - [x] Create seed script for loading test data (`scripts/seed-test-data.ts`)
  - [x] Suppress Chroma SDK "No embedding function" warnings (upstream: https://github.com/chroma-core/chroma/issues/5400)
  - [x] Create unified `vector_search` tool with three composable search dimensions:
    - Semantic search (`query`): natural language → vector similarity via embeddings
    - Keyword search (`keyword`): substring matching via Chroma `where_document` — no embedding call
    - Metadata filters (`kind`, `apiGroup`, `namespace`): exact-match on structured fields
  - [x] Add `keywordSearch()` method to VectorStore interface and ChromaBackend
  - [x] Smart Chroma method selection in the backend:
    - Has `query` → `collection.query()` with embeddings (+ optional `where_document` and `where`)
    - Only `keyword`/filters → `collection.get()` with `where_document`/`where` (no embedding call)
  - [x] Validation: at least one of `query`, `keyword`, or a metadata filter is required
  - [x] Integrate unified tool with existing agent via LangChain wrapper
  - [x] Manual test: agent uses `vector_search` with semantic query and gets correct results
  - [x] Manual test: agent uses `vector_search` with keyword and metadata filter (no embedding call)
  - **Completed**: Unified `vector_search` tool in `src/tools/core/vector-search.ts` with all three composable dimensions. `keywordSearch()` added to VectorStore interface and ChromaBackend using Chroma `collection.get()` with `$contains`. Smart dispatch: has `query` → `search()` with embeddings, only `keyword`/filters → `keywordSearch()` with no embedding call. Deleted separate `vector-filter.ts`. All 7 dimension combinations tested through agent. Graceful degradation verified (Chroma down → kubectl fallback).

- [~] **M4**: ~~Integration and Polish~~ — Redistributed to downstream PRDs
  - ~~End-to-end test with data loaded by PRD #25~~ → moved to PRD #25 M5
  - ~~Tune retrieval parameters (top-k, similarity threshold)~~ → moved to PRD #25 M3
  - ~~Test the "semantic bridge" pattern~~ → already in PRD #26 M4
  - ~~Update documentation with usage patterns~~ → moved to PRD #25 M5

## Technical Approach

### Vector DB Interface

The interface should support at minimum:

```typescript
interface VectorStore {
  initialize(collection: string, options: CollectionOptions): Promise<void>;
  store(collection: string, documents: VectorDocument[]): Promise<void>;
  search(collection: string, query: string, options?: SearchOptions): Promise<SearchResult[]>;
  keywordSearch(collection: string, keyword?: string, options?: SearchOptions): Promise<SearchResult[]>;
  delete(collection: string, ids: string[]): Promise<void>;
}
```

The `search()` method uses embeddings for semantic similarity. The `keywordSearch()` method uses Chroma's `where_document` for substring matching without an embedding API call. Both accept optional `SearchOptions` for metadata filtering. The unified `vector_search` agent tool composes these methods based on which parameters the LLM provides.

The Chroma backend implements this interface. A future Qdrant backend would implement the same interface. PRDs #25 and #26 write to this interface, not to Chroma directly.

### Document Schemas

**Capabilities collection** (populated by PRD #25):

```typescript
{
  id: "devopstoolkit.live/v1beta1/SQL",   // group/version/kind
  document: "SQL (devopstoolkit.live/v1beta1) — A managed database solution...",
  metadata: {
    kind: "SQL",
    apiVersion: "devopstoolkit.live/v1beta1",
    apiGroup: "devopstoolkit.live",
    scope: "Namespaced",
    isCRD: true,
    complexity: "low",
  }
}
```

**Resource instances collection** (populated by PRD #26):

```typescript
{
  id: "default/apps/v1/Deployment/nginx", // namespace/group/version/kind/name
  document: "Deployment nginx | namespace: default | apiVersion: apps/v1 | labels: app=nginx",
  metadata: {
    namespace: "default",
    name: "nginx",
    kind: "Deployment",
    apiVersion: "apps/v1",
    apiGroup: "apps",
  }
}
```

### Search Tool

One unified `vector_search` tool with three composable search dimensions:

1. **Semantic search** (`query` param) — "find resources related to databases" → embeds query, compares via cosine similarity
2. **Keyword search** (`keyword` param) — "find anything mentioning 'backup'" → substring match via Chroma `where_document`, no embedding API call
3. **Metadata filters** (`kind`, `apiGroup`, `namespace` params) — "find all Deployments in apps group" → exact metadata match via Chroma `where`

At least one dimension required. All three compose freely in a single call. The tool picks the optimal Chroma method internally:
- Has `query` → `collection.query()` with embeddings (expensive, semantic)
- Only `keyword`/filters → `collection.get()` with `where_document`/`where` (free, exact)
- Both → `collection.query()` with embeddings + `where_document` (semantic + keyword combined)

**Why one tool instead of separate tools**: Separate tools cause the LLM to make wasteful multi-call patterns (search then filter). A single tool with composable dimensions makes it impossible to use inefficiently and gives the LLM fewer tools to reason about.

### Decisions Resolved During M2

- **Interface shape**: Finalized as shown above. `VectorDocument` has `id`, `text`, and `metadata` fields. `SearchResult` extends this with a `score` (cosine distance). `EmbeddingFunction` is a separate interface with a single `embed(texts)` method, injected into the backend at construction.
- **Chroma server startup**: Manual `chroma run --path ./data` or Docker. Documented in `docs/vector-database.md`.
- **Pre-computed embeddings**: ChromaBackend embeds text via our `EmbeddingFunction` and passes raw vectors to Chroma (not using Chroma's embedding function interface). This keeps the abstraction clean — a Qdrant backend would do the same.
- **Upsert behavior**: `store()` uses Chroma's `upsert` (not `add`) so re-running sync pipelines updates existing documents instead of failing on duplicates.

### Decisions Resolved During M3

- **Keyword search**: Yes, added as a dimension of the unified `vector_search` tool. Uses Chroma's `where_document` / `get()` for substring matching — no embedding API call needed. Faster, free, no rate limits.
- **Result formatting**: Numbered text blocks with distance scores, similarity labels ("very similar", "similar", "somewhat related"), and metadata. Implemented in `src/tools/core/format-results.ts`.
- **One tool, not two**: Merged semantic search and filter query into a single unified `vector_search` tool. The LLM can compose search dimensions freely in one call, avoiding wasteful multi-call patterns. See Design Decisions entry for 2026-02-18.
- **Chroma SDK warnings**: Suppressed via `console.warn` override during collection initialization. The Chroma SDK v3 has no proper pre-computed embeddings mode. Tracked upstream: https://github.com/chroma-core/chroma/issues/5400.

## Dependencies

- Embedding model access (Voyage AI API key, managed via vals)
- Chroma server running locally (dev) or in-cluster (demo)

## Out of Scope

- Capability inference pipeline (PRD #25)
- Resource instance sync (PRD #26)
- Qdrant backend implementation (future PRD)
- Multi-cluster support
- Real-time sync / controller

---

## Design Decisions

**2026-02-11**: M1 research complete. Decided on PRD split: #7 (vector DB + query tools), #25 (capability inference), #26 (resource sync). All data loading code will be vector-DB-agnostic, writing to an interface defined in this PRD. See `docs/vector-db-research.md` for full research findings and `docs/viktors-pipeline-assessment.md` for Viktor's architecture analysis.

**2026-02-11**: Decided to build our own lightweight pipeline (Option C from assessment) rather than using Viktor's stack directly. Viktor's stack targets Qdrant; we need Chroma first. We'll install Viktor's stack later for the Qdrant path of the KubeCon demo.

**2026-02-17**: M2 implementation decisions: (1) Pre-computed embeddings — ChromaBackend calls our EmbeddingFunction and passes raw vectors to Chroma rather than implementing Chroma's EmbeddingFunction interface. Cleaner abstraction, backend-agnostic. (2) Upsert over add — store() uses Chroma upsert so sync pipelines can re-run idempotently. (3) `qs` npm override — voyageai SDK depends on vulnerable qs@6.11.2; overridden to 6.14.1 in package.json. (4) Chroma SDK v3 uses host/port/ssl constructor args (not deprecated `path` arg).

**2026-02-18**: M3 design decisions — unified search tool redesign: (1) **One tool, not two** — Initial implementation had separate `vector_search` (semantic) and `vector_filter` (metadata) tools. During testing, found the LLM made wasteful multi-call patterns (search then filter separately). Merged into a single `vector_search` tool with three composable dimensions: semantic `query`, `keyword` substring match, and metadata filters (`kind`, `apiGroup`, `namespace`). The tool picks the optimal Chroma method internally. (2) **Keyword search added** — Uses Chroma's `where_document` / `get()` for substring matching without an embedding API call. Motivated by Voyage AI rate limits (3 RPM on free tier) and the observation that exact text matching is a valid search strategy alongside semantic search. (3) **Graceful degradation** — If Chroma isn't running, the tool returns a helpful message instead of crashing. If VOYAGE_API_KEY is missing, vector tools are skipped entirely and the agent works with kubectl only. (4) **Lazy initialization** — VectorStore collections initialize on first tool call, not at agent startup. Chroma doesn't need to be running unless the agent actually needs vector search. (5) **Chroma SDK warning suppression** — Chroma v3 logs noisy "No embedding function configuration found" warnings when using pre-computed embeddings (embeddingFunction: null). No SDK option to disable. Suppressed via console.warn override during initialization. Tracked upstream: https://github.com/chroma-core/chroma/issues/5400.

---

## Progress Log

**2026-02-11**: M1 complete. Research documented in `docs/vector-db-research.md`. Viktor's architecture analyzed in `docs/viktors-pipeline-assessment.md`. PRD split decided: #7 (this PRD), #25 (capability inference), #26 (resource sync). Open decisions from research doc addressed; remaining decisions deferred to implementation.

**2026-02-17**: M2 complete. Installed `chromadb@3.3.0` and `voyageai@0.1.0`. Implemented vector store module in `src/vectorstore/`: `types.ts` (VectorStore + EmbeddingFunction interfaces), `embeddings.ts` (VoyageEmbedding using voyage-4), `chroma-backend.ts` (ChromaBackend with pre-computed embeddings, upsert, cosine distance), `index.ts` (exports + collection constants). Added `VOYAGE_API_KEY` to `.vals.yaml`. Created `docs/vector-database.md`. End-to-end test passed: semantic search correctly ranked SQL #1 for "database" queries and Ingress #1 for "network traffic" queries.

**2026-02-18**: M3 initial implementation and redesign. First built two separate tools (vector_search + vector_filter) following the 3-layer pattern (core → LangChain wrapper → agent). Tested successfully with seeded data — agent correctly chose vector_search for conceptual queries, got SQL ranked #1 for "database". Then redesigned: merged into a single unified `vector_search` tool with semantic query + keyword search + metadata filters as composable dimensions. Added keyword search (Chroma `where_document`, no embedding call). Suppressed Chroma SDK warnings. Created `scripts/seed-test-data.ts`. Previous test results invalidated by redesign — retesting required.

**2026-02-18**: M3 complete. Implemented unified `vector_search` tool with all three composable dimensions per PRD spec. Added `keywordSearch()` to VectorStore interface (optional keyword for filter-only path) and ChromaBackend (uses `collection.get()` with `$contains`). Deleted separate `vector-filter.ts`. Smart dispatch: has `query` → `collection.query()` with embeddings, only `keyword`/filters → `collection.get()` (free). Comprehensive agent testing: all 7 dimension combinations verified (semantic, keyword, filter, query+keyword, query+filter, keyword+filter, all three). Graceful degradation confirmed — Chroma down → agent seamlessly falls back to kubectl tools.

**2026-02-18**: M4 redistributed to downstream PRDs. All M4 tasks were integration work blocked on PRD #25 data. Moved: "Tune retrieval parameters" → PRD #25 M3, "End-to-end test with PRD #25 data" and "Update documentation with usage patterns" → PRD #25 M5, "Test semantic bridge pattern" → already in PRD #26 M4. PRD #7 scope is complete with M1–M3 delivering the vector DB interface, Chroma backend, and unified search tool.
