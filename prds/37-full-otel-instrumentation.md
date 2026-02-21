# PRD #37: Full OTel Instrumentation — Data Pipeline, Vector Store, and HTTP API

**Status**: Active
**Created**: 2026-02-21
**GitHub Issue**: [#37](https://github.com/wiggitywhitney/cluster-whisperer/issues/37)

---

## Problem Statement

The agentic investigation flow is well-instrumented — root spans, tool execution, kubectl subprocesses, and LLM calls all produce spans with Weaver-defined attributes. But everything beneath the agent is invisible:

- **Vector store operations** (`ChromaBackend.store()`, `.search()`, `.delete()`, `.initialize()`) are async network calls to Chroma with zero spans. Latency from collection creation, batch upserts, and similarity queries is hidden.
- **Embedding generation** (`VoyageEmbedding.embed()`) makes external HTTP calls to Voyage AI's API. Each call has measurable latency and token cost, but nothing shows up in traces.
- **Pipeline orchestration** (`syncCapabilities()`, `syncInstances()`) runs multi-minute discover → infer → store workflows. The only visibility comes from individual kubectl spans inside discovery — the overall pipeline flow, stage transitions, and aggregate counts are invisible.
- **HTTP API** (PRD #35's `POST /api/v1/instances/sync` endpoint) will accept push-based instance sync from k8s-vectordb-sync. PRD #35 explicitly lists OTel instrumentation as out of scope.

The Weaver schema in `telemetry/registry/attributes.yaml` defines conventions for 5 attribute groups — all scoped to the agentic flow (root, tool, LLM, MCP, subprocess). There are no conventions for vector store, embedding, pipeline, or HTTP server operations.

This matters because the KubeCon demo needs to show the full observable system: user question → agent reasoning → tool calls → kubectl → vector search → embedding → storage. Today, the trace tree has gaps in the middle and bottom.

## Solution

Extend the Weaver semantic convention schema with 4 new attribute groups and add OTel spans to all uninstrumented layers. Follow the existing patterns — `getTracer()` for span creation, content-gating for sensitive data, `cluster_whisperer.*` namespace for custom attributes, and OTel semconv `ref:` imports where official conventions exist.

### Instrumentation Scope

| Layer | File(s) | Span Pattern | Semconv Source |
|-------|---------|-------------|----------------|
| Vector store | `src/vectorstore/chroma-backend.ts` | One span per method call | OTel DB semconv (`db.*`) |
| Embeddings | `src/vectorstore/embeddings.ts` | One span per `embed()` call | OTel GenAI semconv (`gen_ai.*`) |
| Pipeline | `src/pipeline/runner.ts`, `instance-runner.ts` | One parent span per pipeline run, child spans per stage | Custom `cluster_whisperer.pipeline.*` |
| HTTP server | `src/api/` (PRD #35) | One span per HTTP request | OTel HTTP semconv (`http.*`, `url.*`) |

### What Doesn't Change

- Existing instrumentation (root spans, tool tracing, kubectl, LLM auto-instrumentation, context bridge)
- Tracing module architecture (OpenLLMetry owns TracerProvider)
- Opt-in behavior (`OTEL_TRACING_ENABLED=true` still required)
- Content-gating (`OTEL_CAPTURE_AI_PAYLOADS=true` for sensitive data)
- No-op when disabled (zero overhead)

---

## Success Criteria

- [ ] Weaver schema extended with 4 new attribute groups (vector store, embedding, pipeline, HTTP server)
- [ ] All `ChromaBackend` methods produce spans with DB semconv attributes
- [ ] `VoyageEmbedding.embed()` produces spans with GenAI semconv attributes
- [ ] Pipeline runners (`syncCapabilities`, `syncInstances`) produce parent/child span trees
- [ ] PRD #35 HTTP server produces request spans with HTTP semconv attributes
- [ ] Full trace tree visible in Datadog: investigation → tool → kubectl/vectorstore/embedding
- [ ] Full trace tree visible in Datadog: HTTP sync → pipeline stages → vectorstore → embedding
- [ ] Existing tests pass (no regressions from adding spans)
- [ ] New span creation covered by unit tests

## Milestones

- [ ] **M1**: Extend Weaver Schema
  - Add `registry.cluster_whisperer.vectorstore` attribute group with OTel DB semconv refs
  - Add `registry.cluster_whisperer.embedding` attribute group with GenAI semconv refs
  - Add `registry.cluster_whisperer.pipeline` attribute group with custom pipeline attributes
  - Add `registry.cluster_whisperer.http` attribute group with OTel HTTP semconv refs
  - Run `weaver registry check` to validate the schema
  - Document new attribute groups in the attributes.yaml header comments

- [ ] **M2**: Vector Store Instrumentation
  - Import `getTracer()` in `src/vectorstore/chroma-backend.ts`
  - Wrap `initialize()` in a span: `cluster-whisperer.vectorstore.initialize`
  - Wrap `store()` in a span: `cluster-whisperer.vectorstore.store`
  - Wrap `search()` in a span: `cluster-whisperer.vectorstore.search`
  - Wrap `keywordSearch()` in a span: `cluster-whisperer.vectorstore.keyword_search`
  - Wrap `delete()` in a span: `cluster-whisperer.vectorstore.delete`
  - Set DB semconv attributes on each span (`db.system`, `db.operation.name`, `db.collection.name`)
  - Set custom attributes: document count, result count, batch size
  - Set span status on errors (Chroma failures → ERROR status)

- [ ] **M3**: Embedding Instrumentation
  - Import `getTracer()` in `src/vectorstore/embeddings.ts`
  - Wrap `embed()` in a span: `cluster-whisperer.embedding.embed`
  - Set GenAI semconv attributes (`gen_ai.operation.name: "embeddings"`, `gen_ai.request.model`)
  - Set custom attributes: input text count, embedding dimensions
  - Set span status on errors (Voyage API failures → ERROR status)

- [ ] **M4**: Pipeline Instrumentation
  - Import `getTracer()` in `src/pipeline/runner.ts` and `src/pipeline/instance-runner.ts`
  - Wrap `syncCapabilities()` in a parent span: `cluster-whisperer.pipeline.sync-capabilities`
  - Create child spans for each stage: discovery, inference, storage
  - Wrap `syncInstances()` in a parent span: `cluster-whisperer.pipeline.sync-instances`
  - Create child spans for each stage: discovery, stale-cleanup, storage
  - Set custom attributes: discovered count, inferred count, stored count, deleted count
  - Set span status based on pipeline outcome

- [ ] **M5**: HTTP Server Instrumentation (PRD #35)
  - Add Hono middleware that creates a span per incoming request
  - Set HTTP semconv attributes (`http.request.method`, `url.path`, `http.response.status_code`, `http.route`)
  - Set custom attributes on the sync endpoint span: upsert count, delete count
  - Propagate trace context from incoming requests (W3C Trace Context headers)
  - Health/readiness probes (`/healthz`, `/readyz`) get spans too (opt-out via config if noisy)

- [ ] **M6**: Datadog Verification
  - Run capability sync (`cluster-whisperer sync`) with `OTEL_TRACING_ENABLED=true`
  - Verify pipeline → vectorstore → embedding span tree in Datadog APM
  - Run instance sync (`cluster-whisperer sync-instances`) with tracing enabled
  - Verify pipeline → stale-cleanup → vectorstore → embedding span tree
  - Run investigation (`cluster-whisperer investigate`) with tracing enabled
  - Verify tool → vectorstore → embedding spans nest under root investigation span
  - Run HTTP sync (PRD #35) with tracing enabled
  - Verify HTTP request → vectorstore → embedding span tree
  - Compare attribute coverage against Weaver schema — every defined attribute should appear

- [ ] **M7**: Tests
  - Unit tests: verify each instrumented function creates spans with correct attributes
  - Unit tests: verify span status is set correctly on success and error paths
  - Unit tests: verify no spans created when tracing is disabled (no-op tracer)
  - Integration tests: verify parent-child span hierarchy for pipeline runs
  - Integration tests: verify HTTP middleware produces correct span tree
  - Existing test suite passes with no regressions

## Technical Approach

### New Weaver Schema Attribute Groups

#### Vector Store Attributes

```yaml
- id: registry.cluster_whisperer.vectorstore
  type: attribute_group
  display_name: Vector Store Attributes
  brief: Attributes for vector database operation spans
  attributes:
    # OTel DB semantic convention references
    - ref: db.system              # "chromadb"
    - ref: db.operation.name      # "upsert", "query", "get", "delete", "get_or_create_collection"
    - ref: db.collection.name     # "capabilities", "instances"

    # Custom attributes
    - id: cluster_whisperer.vectorstore.document_count
      type: int
      stability: development
      brief: Number of documents in the operation (store batch size, search results)

    - id: cluster_whisperer.vectorstore.result_count
      type: int
      stability: development
      brief: Number of results returned from a search query
```

#### Embedding Attributes

```yaml
- id: registry.cluster_whisperer.embedding
  type: attribute_group
  display_name: Embedding Attributes
  brief: Attributes for embedding generation spans
  attributes:
    # OTel GenAI semantic convention references
    - ref: gen_ai.operation.name  # "embeddings"
    - ref: gen_ai.request.model   # "voyage-4"

    # Custom attributes
    - id: cluster_whisperer.embedding.input_count
      type: int
      stability: development
      brief: Number of text inputs sent for embedding
```

#### Pipeline Attributes

```yaml
- id: registry.cluster_whisperer.pipeline
  type: attribute_group
  display_name: Pipeline Attributes
  brief: Attributes for sync pipeline orchestration spans
  attributes:
    - id: cluster_whisperer.pipeline.name
      type: string
      stability: development
      brief: Pipeline identifier
      examples: ["sync-capabilities", "sync-instances"]

    - id: cluster_whisperer.pipeline.stage
      type: string
      stability: development
      brief: Current pipeline stage
      examples: ["discovery", "inference", "storage", "stale-cleanup"]

    - id: cluster_whisperer.pipeline.discovered_count
      type: int
      stability: development
      brief: Number of resources discovered

    - id: cluster_whisperer.pipeline.stored_count
      type: int
      stability: development
      brief: Number of documents stored

    - id: cluster_whisperer.pipeline.deleted_count
      type: int
      stability: development
      brief: Number of stale documents deleted

    - id: cluster_whisperer.pipeline.dry_run
      type: boolean
      stability: development
      brief: Whether the pipeline ran in dry-run mode (skip storage)
```

#### HTTP Server Attributes

```yaml
- id: registry.cluster_whisperer.http
  type: attribute_group
  display_name: HTTP Server Attributes
  brief: Attributes for HTTP server request spans
  attributes:
    # OTel HTTP semantic convention references
    - ref: http.request.method    # "POST", "GET"
    - ref: http.response.status_code  # 200, 400, 500
    - ref: http.route             # "/api/v1/instances/sync", "/healthz"
    - ref: url.path               # Actual path (may differ from route with params)

    # Custom attributes for sync endpoint
    - id: cluster_whisperer.sync.upsert_count
      type: int
      stability: development
      brief: Number of upserts in the sync payload

    - id: cluster_whisperer.sync.delete_count
      type: int
      stability: development
      brief: Number of deletes in the sync payload
```

### Span Naming Conventions

Follow the existing pattern: `cluster-whisperer.<layer>.<operation>`

| Span Name | Source | Kind |
|-----------|--------|------|
| `cluster-whisperer.vectorstore.initialize` | `ChromaBackend.initialize()` | CLIENT |
| `cluster-whisperer.vectorstore.store` | `ChromaBackend.store()` | CLIENT |
| `cluster-whisperer.vectorstore.search` | `ChromaBackend.search()` | CLIENT |
| `cluster-whisperer.vectorstore.keyword_search` | `ChromaBackend.keywordSearch()` | CLIENT |
| `cluster-whisperer.vectorstore.delete` | `ChromaBackend.delete()` | CLIENT |
| `cluster-whisperer.embedding.embed` | `VoyageEmbedding.embed()` | CLIENT |
| `cluster-whisperer.pipeline.sync-capabilities` | `syncCapabilities()` | INTERNAL |
| `cluster-whisperer.pipeline.sync-instances` | `syncInstances()` | INTERNAL |
| `cluster-whisperer.http.request` | Hono middleware | SERVER |

SpanKind rationale:
- **CLIENT** for vector store and embedding — outbound network calls to external services (Chroma, Voyage AI)
- **INTERNAL** for pipeline — local orchestration, no network boundary
- **SERVER** for HTTP — inbound request handling

### Expected Trace Trees (After Implementation)

**Investigation flow:**
```text
cluster-whisperer.cli.investigate (root)
├── anthropic.chat (LLM, auto-instrumented)
├── kubectl_get.tool (tool span)
│   └── kubectl get pods (subprocess span)
├── vector_search.tool (tool span)
│   └── cluster-whisperer.vectorstore.search (NEW)
│       └── cluster-whisperer.embedding.embed (NEW)
├── anthropic.chat (LLM, auto-instrumented)
└── kubectl_describe.tool (tool span)
    └── kubectl describe pod nginx (subprocess span)
```

**Capability sync flow:**
```text
cluster-whisperer.pipeline.sync-capabilities (NEW, parent)
├── discovery (NEW, child stage)
│   └── kubectl get ... (subprocess span, existing)
├── inference (NEW, child stage)
│   └── anthropic.chat (LLM, auto-instrumented)
└── storage (NEW, child stage)
    └── cluster-whisperer.vectorstore.store (NEW)
        └── cluster-whisperer.embedding.embed (NEW)
```

**HTTP sync flow (PRD #35):**
```text
cluster-whisperer.http.request (NEW, SERVER)
├── cluster-whisperer.vectorstore.delete (NEW, if deletes present)
└── cluster-whisperer.vectorstore.store (NEW, if upserts present)
    └── cluster-whipperer.embedding.embed (NEW)
```

### Implementation Pattern

Follow the same pattern used in `src/utils/kubectl.ts`:

```typescript
import { getTracer } from "../tracing";
import { SpanKind, SpanStatusCode } from "@opentelemetry/api";

const tracer = getTracer();

async search(collection: string, query: string, options?: SearchOptions): Promise<SearchResult[]> {
  return tracer.startActiveSpan(
    "cluster-whisperer.vectorstore.search",
    { kind: SpanKind.CLIENT },
    async (span) => {
      try {
        span.setAttribute("db.system", "chromadb");
        span.setAttribute("db.operation.name", "query");
        span.setAttribute("db.collection.name", collection);

        // ... existing search logic ...

        span.setAttribute("cluster_whisperer.vectorstore.result_count", results.length);
        span.setStatus({ code: SpanStatusCode.OK });
        return results;
      } catch (error) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: String(error) });
        span.recordException(error as Error);
        throw error;
      } finally {
        span.end();
      }
    }
  );
}
```

### W3C Trace Context Propagation (HTTP Server)

The Hono middleware should extract `traceparent` / `tracestate` headers from incoming requests. This enables the k8s-vectordb-sync controller (PRD #35's client) to propagate its trace context, creating a cross-service trace tree:

```text
k8s-vectordb-sync controller (Go)
└── HTTP POST /api/v1/instances/sync
    └── cluster-whisperer.http.request (SERVER, this PRD)
        ├── cluster-whisperer.vectorstore.delete
        └── cluster-whisperer.vectorstore.store
            └── cluster-whisperer.embedding.embed
```

Use OTel's `propagation.extract()` with the W3C TraceContext propagator (registered by default in the SDK).

## Dependencies

- **PRD #33** (OTel Peer Dependencies) — must be completed first so the dependency structure is clean before adding new instrumentation
- **PRD #35** (Instance Sync REST Endpoint) — M5 (HTTP server instrumentation) depends on the Hono server existing
- **PRD #6** (OpenTelemetry Instrumentation) — the existing instrumentation this PRD extends
- **PRD #8** (Datadog Observability) — Datadog used for M6 verification
- Running ChromaDB instance for integration tests
- Voyage AI API key for embedding spans in integration tests
- Live Kubernetes cluster for pipeline trace verification

## Out of Scope

- Changing existing instrumentation (root spans, tool tracing, kubectl, context bridge)
- Metrics (this PRD is traces only; metrics are a separate concern)
- Log correlation (structured logging with trace IDs)
- Continuous profiling
- Custom Datadog dashboards or monitors for the new spans
- Performance optimization of the instrumentation itself
- Instrumenting LangGraph internal state transitions (blocked by OpenLLMetry-JS issue #476)

---

## Design Decisions

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-02-21 | OTel DB semconv for ChromaBackend | Chroma is a database; `db.system`, `db.operation.name`, `db.collection.name` are the standard way to describe DB client operations. |
| 2026-02-21 | GenAI semconv for embedding spans | OTel GenAI semconv defines `gen_ai.operation.name: "embeddings"` for embedding generation. Voyage AI is an AI model provider. |
| 2026-02-21 | Custom `cluster_whisperer.pipeline.*` for pipeline spans | No OTel semconv exists for data pipeline orchestration. Custom namespace avoids future conflicts. |
| 2026-02-21 | OTel HTTP semconv for Hono server | Standard HTTP server semconv (`http.request.method`, `http.response.status_code`, `http.route`) — well-established, widely supported by backends. |
| 2026-02-21 | After PRD #33 and #35 | Clean dependency structure first (33), then create the code to instrument (35), then instrument everything in one pass (37). |
| 2026-02-21 | Trace Context propagation for HTTP endpoint | Enables cross-service traces between k8s-vectordb-sync controller and cluster-whisperer. The controller already has OTel instrumentation. |

---

## Progress Log

*Progress will be logged here as milestones are completed.*
