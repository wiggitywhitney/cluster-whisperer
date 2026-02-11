# PRD #7: Vector Database Integration (Chroma)

**Status**: In Progress (M1 Complete)
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

- [ ] Chroma running and accessible from the agent
- [ ] Vector DB interface defined that other PRDs can write to
- [ ] Chroma backend implements the interface
- [ ] Agent has a semantic search tool that queries the vector DB
- [ ] Agent has a filter-based query tool for structured lookups
- [ ] Documentation explains vector DB concepts and our implementation

## Milestones

- [x] **M1**: Research Phase
  - Study Chroma documentation and official examples
  - Research embedding models for technical documentation
  - Study Viktor's architecture for K8s sync patterns
  - Document findings in `docs/vector-db-research.md`
  - Decide on PRD split (controller as separate PRDs)
  - **Completed**: Research documented, decisions made, PRD split into #7, #25, #26

- [ ] **M2**: Chroma Setup and Vector DB Interface
  - Install Chroma packages (`chromadb`)
  - Install embedding packages (Voyage AI `voyage-4`)
  - Define vector DB interface (store, search, delete, initialize collection)
  - Implement Chroma backend behind the interface
  - Configure Chroma connection (localhost:8000 for dev)
  - Configure embedding model behind the interface
  - Create two collections with cosine distance metric (capabilities + resource instances)
  - Manual test: can store and retrieve test documents through the interface
  - Create `docs/vector-database.md` explaining vector DB concepts

- [ ] **M3**: Search Tools for the Agent
  - Create semantic search tool (natural language query → vector similarity search)
  - Create filter-based query tool (structured lookups by kind, apiGroup, etc.)
  - Format search results for LLM consumption
  - Integrate tools with existing agent (MCP tool or LangGraph tool)
  - Manual test: agent can search for resources by concept ("database", "ingress")

- [ ] **M4**: Integration and Polish
  - End-to-end test with data loaded by PRD #25 (capability inference)
  - Tune retrieval parameters (top-k, similarity threshold)
  - Test the "semantic bridge" pattern: semantic search finds types → filter query finds instances
  - Update documentation with usage patterns

## Technical Approach

### Vector DB Interface

The interface should support at minimum:

```typescript
interface VectorStore {
  initialize(collection: string, options: CollectionOptions): Promise<void>;
  store(collection: string, documents: VectorDocument[]): Promise<void>;
  search(collection: string, query: string, options: SearchOptions): Promise<SearchResult[]>;
  delete(collection: string, ids: string[]): Promise<void>;
}
```

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

### Search Tools

Two complementary tools for the agent:
1. **Semantic search** — "find resources related to databases" → vector similarity
2. **Filter query** — "find all CRDs in the crossplane.io group" → metadata filtering

### Decisions Deferred to Implementation

- Exact interface shape (will be refined when implementing M2)
- How the Chroma server is started for development (manual `chroma run` vs Docker vs script)
- Whether to add keyword search alongside vector search (Chroma has built-in full-text search)

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

---

## Progress Log

**2026-02-11**: M1 complete. Research documented in `docs/vector-db-research.md`. Viktor's architecture analyzed in `docs/viktors-pipeline-assessment.md`. PRD split decided: #7 (this PRD), #25 (capability inference), #26 (resource sync). Open decisions from research doc addressed; remaining decisions deferred to implementation.
