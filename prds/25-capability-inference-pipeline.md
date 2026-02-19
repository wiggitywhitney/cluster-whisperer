# PRD #25: Capability Inference Pipeline

**Status**: Complete
**Created**: 2026-02-11
**GitHub Issue**: [#25](https://github.com/wiggitywhitney/cluster-whisperer/issues/25)

---

## Problem Statement

Kubernetes clusters with Crossplane, operators, or other extensions can have hundreds of CRDs. Their names alone (e.g., `sqls.devopstoolkit.live`, `buckets.s3.aws.upbound.io`) don't tell a developer what they do, which cloud providers they support, or how complex they are to use.

The agent needs semantic understanding of what each resource type provides so it can answer questions like "how do I deploy a database?" by finding the right CRD among hundreds.

## Solution

Build a pipeline that:
1. Discovers CRDs and API resources in a Kubernetes cluster
2. Analyzes each resource's schema with an LLM to generate structured capability descriptions
3. Stores those descriptions in the vector database (via PRD #7's interface) for semantic search

This is the "capability inference" system — it translates raw CRD schemas into human-understandable descriptions the agent can search over.

### KubeCon Demo Context

This pipeline powers **Act 2** of the presentation: "too many provider CRDs, developer doesn't know how to navigate them, agent uses vector DB to find the right one."

### How Viktor Does It (for reference)

Viktor's `dot-ai` system has a `CapabilityInferenceEngine` that does the same thing:
- Runs `kubectl explain <resource> --recursive` to get CRD schemas
- Sends each schema to an LLM with a structured prompt (~120 lines of Handlebars template)
- The LLM returns: capabilities, providers, abstractions, complexity, description, useCase, confidence
- Results are stored in a `capabilities` collection in Qdrant
- A Kubernetes controller (`dot-ai-controller`) watches for CRD events and triggers scans automatically

Our version will be lighter-weight — a CLI tool or startup script rather than a full controller — but the core inference logic is the same pattern. See `docs/viktors-pipeline-assessment.md` for full analysis.

---

## Success Criteria

- [x] Pipeline discovers CRDs and API resources from a live cluster
- [x] LLM analyzes each resource schema and produces structured capability descriptions
- [x] Capability descriptions are stored in the vector database via PRD #7's interface
- [x] Agent can semantically search capabilities (e.g., "database" finds `sqls.devopstoolkit.live`)
- [x] Pipeline is vector-DB-agnostic (works with Chroma now, Qdrant later)
- [x] Documentation explains how the inference pipeline works

## Milestones

- [x] **M1**: CRD Discovery
  - Discover all CRDs and API resources in the cluster
  - Extract schema information for each (via `kubectl explain --recursive` or K8s API)
  - Filter out low-value resources (Events, Leases, EndpointSlices, subresources)
  - Output: a list of resources with their schema text, ready for LLM analysis

- [x] **M2**: LLM Inference Pipeline
  - Design the prompt template for capability inference
  - Send resource schemas to the LLM, parse structured JSON responses
  - Define the `ResourceCapability` data structure (capabilities, providers, complexity, description, useCase)
  - Handle LLM errors and validation of responses
  - Output: structured capability descriptions for each resource

- [x] **M3**: Storage and Search
  - Store capability descriptions in the vector DB via PRD #7's interface
  - Construct embedding text from capability fields (name + capabilities + description + useCase)
  - Store metadata for filtering (kind, apiGroup, complexity, providers)
  - Verify semantic search works: "database" → finds database-related CRDs
  - Verify filter search works: "all low-complexity resources" → filters by metadata
  - Tune retrieval parameters (top-k, similarity threshold) with real capability data

- [x] **M4**: CLI Tool / Runner
  - Wrap the pipeline as a runnable tool (CLI command, npm script, or startup hook)
  - ~~Support scanning all resources or a specific subset~~ (subset scanning deferred — not needed for KubeCon demo)
  - Log progress (N of M resources scanned)
  - Handle incremental updates (re-scan only changed/new CRDs, or full rescan)

- [x] **M5**: End-to-End Demo Validation
  - Load capabilities from the demo cluster (with many database CRDs installed)
  - Test the full flow: user asks "how do I deploy a database?" → agent searches capabilities → finds the right CRD → recommends it
  - Document the pipeline setup and usage
  - Update vector database documentation (`docs/vector-database.md`) with real usage patterns

## Technical Approach

### Capability Data Structure

Each capability describes what a resource type can do:

```typescript
interface ResourceCapability {
  resourceName: string;        // "sqls.devopstoolkit.live"
  apiVersion: string;          // "devopstoolkit.live/v1beta1"
  group: string;               // "devopstoolkit.live"
  kind: string;                // "SQL"
  capabilities: string[];      // ["postgresql", "mysql", "database"]
  providers: string[];         // ["azure", "gcp", "aws"]
  complexity: "low" | "medium" | "high";
  description: string;         // "Managed database solution supporting multiple engines"
  useCase: string;             // "Simple database deployment without infrastructure complexity"
  confidence: number;          // 0-1, LLM's confidence in its analysis
}
```

### Inference Flow

```text
kubectl explain <resource> --recursive
        |
        v
   LLM prompt (schema + instructions)
        |
        v
   Structured JSON response
        |
        v
   Validate + parse into ResourceCapability
        |
        v
   Generate embedding text: "SQL (devopstoolkit.live) — database, postgresql, mysql.
     Managed database solution supporting multiple engines.
     Use for simple database deployment without infrastructure complexity."
        |
        v
   Store via VectorStore interface (PRD #7)
```

### Prompt Design

The prompt template should:
- Provide the full `kubectl explain --recursive` output for the resource
- Instruct the LLM to identify functional capabilities, provider support, and complexity
- Request a specific JSON output format
- Include examples to guide consistent output
- Instruct the LLM to only use information present in the schema (no guessing)

### Decisions Deferred to Implementation

- ~~Exact prompt template wording (will iterate during M2)~~ → Decided: see `prompts/capability-inference.md`
- ~~Whether to use `kubectl explain` via subprocess or the Kubernetes API directly~~ → Decided: subprocess (see Design Decisions)
- ~~Whether to run inference sequentially or in parallel (sequential is simpler, parallel is faster)~~ → Decided: sequential (see Design Decisions)
- How to handle resources where `kubectl explain` returns minimal information
- ~~Whether the runner is a standalone CLI, an npm script, or integrated into the MCP server startup~~ → Decided: `sync` subcommand of existing CLI (see Design Decisions)

## Dependencies

- **PRD #7** (Vector Database Integration) — must have the vector DB interface and Chroma backend working
- LLM API access (Anthropic or OpenAI, managed via vals)
- Kubernetes cluster access (kubeconfig)
- A cluster with CRDs installed (the demo cluster with database providers)

## Out of Scope

- Real-time CRD watching / controller (could be a future enhancement)
- Resource instance sync (PRD #26)
- Qdrant backend (PRD #7 provides the interface; Qdrant implementation is a future PRD)

---

## Design Decisions

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-02-18 | kubectl explain via subprocess (not K8s API) | Reuses existing `executeKubectl` helper with OTel tracing and shell injection safety. Consistent with project architecture. |
| 2026-02-18 | Sequential schema extraction (not parallel) | Simpler implementation. Real-world performance is ~3 seconds total for a cluster — no need for concurrency complexity. |
| 2026-02-18 | Dependency injection for testability | `DiscoveryOptions.kubectl` parameter allows mocking at the system boundary. Enables fast, offline unit tests alongside integration tests. |
| 2026-02-18 | Name-based resource filtering | Conservative exclusion list (events, leases, endpointslices, endpoints, componentstatuses). Also excludes subresources (name contains `/`) and resources without `get` verb. |
| 2026-02-18 | vitest as test framework | Fast, TypeScript-native, zero-config. Added `test` and `test:watch` scripts to package.json. |
| 2026-02-18 | Haiku for batch inference (not Sonnet) | M2 processes dozens of resources sequentially. Haiku is faster, cheaper, and sufficient for schema analysis. Sonnet reserved for investigator agent where reasoning depth matters. |
| 2026-02-18 | Zod + withStructuredOutput() for LLM responses | Guarantees valid JSON matching schema via Anthropic's tool_use under the hood. Zod already a dependency. Eliminates manual JSON parsing and regex. |
| 2026-02-18 | Prompt template as separate .md file | Matches investigator.md pattern in `prompts/` directory. Easy to iterate on prompt wording without touching code. |
| 2026-02-18 | Assembly complexity in prompt (inspired by Viktor's dot-ai) | Viktor's prompt distinguishes standalone/coordinated/orchestrated resources. Adopted this for our complexity assessment — a Crossplane Composition is "low config, standalone" while a raw RDS Instance is "high config, coordinated." Also added 3 examples (database, storage, core K8s) vs 1, matching Viktor's pattern of diverse reference points. |
| 2026-02-19 | Embedding text: Kind+group header, then capabilities, providers, complexity, description, useCase | Maximizes semantic match quality. Integration tests confirm "database" → SQL CRD as top result, "traffic routing" → Ingress, "object storage backup" → S3 Bucket. |
| 2026-02-19 | Providers stored as comma-separated string in metadata | Chroma metadata values must be primitives (no arrays). Provider names also appear in embedding text for semantic matching. |
| 2026-02-19 | Added `complexity` filter to `vector_search` tool | PRD M3 requires "all low-complexity resources" filtering. Added to the existing tool schema alongside kind, apiGroup, namespace. |
| 2026-02-19 | `sync` subcommand of existing CLI (not separate binary or npm script) | Follows existing commander pattern in `src/index.ts`. Single unified CLI surface. "sync" name chosen over "infer"/"scan"/"seed" — implies aligning vector DB with cluster state, reads naturally for re-runs. |
| 2026-02-19 | Full rescan with upsert (not incremental diff) | Simplest correct implementation. VectorStore.store() uses upsert, so re-runs are safe. Incremental diff adds complexity for marginal benefit on ~100 resources. |
| 2026-02-19 | Subset scanning deferred | `--kinds`/`--groups` filters not needed for KubeCon demo. Full scan is the primary use case. Can be added later if needed. |
| 2026-02-19 | VectorStore as required parameter to runner | CLI creates dependencies (ChromaBackend + VoyageEmbedding) and passes them in. Runner stays testable via DI, matching M1/M2/M3 pattern. |
| 2026-02-19 | Investigator prompt needs explicit vector search guidance | Without prompt guidance, the agent defaulted to generic K8s knowledge instead of searching capabilities. Added "Two Modes of Operation" section: discovery questions → vector_search first, investigation questions → kubectl tools. |

---

## Progress Log

### 2026-02-18: M1 Complete — CRD Discovery
- Created `src/pipeline/` directory with types, discovery logic, and barrel exports
- `parseApiResources()` parses `kubectl api-resources -o wide` fixed-width table output
- `filterResources()` removes subresources, high-churn system resources, and resources without `get` verb
- `discoverResources()` orchestrates: discover → filter → extract schemas via `kubectl explain --recursive`
- `DiscoveredResource` type includes fully qualified name, apiVersion, group, kind, isCRD flag, and schema text
- 33 unit tests (mocked kubectl) + 6 integration tests (live cluster) — all passing
- Set up vitest test framework as project-wide dev dependency

### 2026-02-18: M2 Design + Test Cluster Setup
- Agreed on M2 design decisions: Haiku model, Zod structured output, .md prompt template
- Installed Crossplane v2.2.0 in target cluster
- Installed 8 AWS database Upbound providers (v1.23.2): RDS, DynamoDB, ElastiCache, DocumentDB, Neptune, Redshift, MemoryDB, Keyspaces
- Cluster now has 106 CRDs total, 76 database-related — realistic test data for inference pipeline

### 2026-02-18: M2 Complete — LLM Inference Pipeline
- Created `prompts/capability-inference.md` with structured instructions and example output
- Added `ResourceCapability`, `LlmCapabilityResult`, and `InferenceOptions` types to `src/pipeline/types.ts`
- Implemented `inferCapability()` (single resource) and `inferCapabilities()` (batch with skip-on-failure) in `src/pipeline/inference.ts`
- Zod schema `LlmCapabilitySchema` with `.describe()` annotations powers `withStructuredOutput()` — guaranteed valid JSON
- LLM returns 6 inferred fields (capabilities, providers, complexity, description, useCase, confidence); resource metadata (name, apiVersion, group, kind) copied from `DiscoveredResource`
- Same DI pattern as M1: `InferenceOptions.model` injectable for testing, defaults to Haiku
- 11 unit tests (mocked model) + 9 integration tests (real Haiku API) — all passing
- Integration tests confirm: SQL CRD → database/postgresql capabilities, ConfigMap → configuration capabilities with empty providers
- Full test suite: 59 tests passing (33 M1 unit + 6 M1 integration + 11 M2 unit + 9 M2 integration)

### 2026-02-19: M3 Complete — Storage and Search
- Created `src/pipeline/storage.ts` with `capabilityToDocument()` (pure mapping) and `storeCapabilities()` (orchestrator)
- `capabilityToDocument()` builds embedding text: Kind+group header → capabilities → providers+complexity → description → useCase
- Metadata stored as flat key-value pairs: kind, apiGroup, apiVersion, complexity, providers (comma-separated), confidence, resourceName
- Added `StorageOptions` interface to `src/pipeline/types.ts` with DI pattern matching M1/M2
- Added `complexity` filter to `vector_search` tool (`src/tools/core/vector-search.ts`) for "all low-complexity resources" queries
- 22 unit tests (mocked VectorStore) + 10 integration tests (real Chroma + Voyage AI) — all passing
- Integration tests confirm: "database" → SQL CRD top result, "traffic routing" → Ingress found, `complexity:"low"` filter works, combined semantic+filter works, keyword "postgresql" → SQL CRD found
- Full test suite: 91 tests passing (33 M1 unit + 6 M1 integration + 11 M2 unit + 9 M2 integration + 22 M3 unit + 10 M3 integration)

### 2026-02-19: M4 Complete — CLI Tool / Runner
- Created `src/pipeline/runner.ts` with `syncCapabilities()` — orchestrates discover → infer → store
- `SyncOptions` interface accepts injectable VectorStore, forwarded DiscoveryOptions/InferenceOptions, dryRun flag
- `SyncResult` returns counts: discovered, inferred, stored
- Runner passes single `onProgress` callback through all three stages for unified progress output
- Added `sync` subcommand to `src/index.ts` with `--dry-run` and `--chroma-url` options
- Split environment validation into composable functions: `validateKubectl()`, `validateAnthropicKey()`, `validateVoyageKey()`
- Updated `src/pipeline/index.ts` barrel exports with runner, SyncOptions, SyncResult
- 12 unit tests (mocked pipeline stages via vi.mock) + 2 integration tests (mock kubectl, real Haiku + Chroma + Voyage)
- Full unit test suite: 78 tests passing (33 M1 + 11 M2 + 22 M3 + 12 M4)
- Deferred: subset scanning (`--kinds`/`--groups`), incremental diff (using full rescan with upsert instead)

### 2026-02-19: M5 Complete — End-to-End Demo Validation
- Ran full sync against demo cluster: 153 resources discovered, 153 inferred, 153 stored (Crossplane + 8 AWS database providers, 166 total API resources, 13 filtered)
- Validated full agent flow via MCP and CLI:
  - "How do I deploy a database?" → agent searched capabilities → found RDS, DocumentDB, Neptune, Keyspaces → recommended Crossplane approach with specific CRD names
  - "What are the simplest resources?" → agent used complexity filter → found ConfigMap, Secret, Service, Namespace
  - "Search capabilities for managed database" → semantic search returned ranked results with correct distances
- Updated `prompts/investigator.md` with "Two Modes of Operation" section — agent now uses vector search for discovery questions and kubectl for investigation questions
- Created `docs/capability-inference-pipeline.md` covering setup, sync command, data structures, embedding text format, metadata fields, and architecture
- Updated `docs/vector-database.md` with real usage patterns: semantic search examples, keyword search, metadata filters, combined queries, and the discovery→investigation flow
- Full test suite: 105 tests passing (78 unit + 27 integration)
- All success criteria met, all milestones complete
