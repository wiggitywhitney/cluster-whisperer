# PRD #48: Cluster-Whisperer Demo Modifications

**Status**: In Progress
**Priority**: High
**Dependencies**: PRD #47 (demo cluster, for end-to-end testing)
**Execution Order**: 4 of 5 — Needs demo cluster for testing. Must complete before PRD #49 (Vercel agent uses the shared tool core and --agent flag).
**Branch**: `feature/prd-48-demo-modifications`

## Problem

The existing cluster-whisperer agent has three kubectl read tools and a vector search
tool, all wired into a single LangGraph agent. The "Choose Your Own Adventure" demo
needs:

1. A new `kubectl_apply` tool that deploys resources — but only from the approved catalog
2. CLI flags to control which tools the agent has access to (enabling the "progressive capability" narrative)
3. A `--vector-backend` flag to switch between Chroma and Qdrant at runtime
4. A Qdrant implementation of the VectorStore interface
5. An `--agent` flag to switch between LangGraph and Vercel (for PRD #49)
6. OTel instrumentation for the Qdrant backend

All of these are additions. The existing LangGraph + Chroma flow must continue working
unchanged (the May conference talk depends on it).

7. Environment variable support for all CLI flags (demo ergonomics — presenter sets env vars after audience votes instead of typing long flag combinations)
8. Kubeconfig pass-through so the agent has cluster access but the presenter's shell does not (governance narrative)
9. OTel Collector ingress so locally-run agent traces reach Jaeger/Datadog (Act 4)

## Solution

Add the new tool, CLI flags, and Qdrant backend as new files alongside existing code.
The three-layer tool architecture (`core/` → `langchain/` + `mcp/`) already supports
adding new tools. The `VectorStore` interface already supports backend swapping.

For the demo runtime, the CLI runs the agent locally with a dedicated kubeconfig
(`CLUSTER_WHISPERER_KUBECONFIG`) that the presenter's shell doesn't export. This means
`kubectl get pods` typed directly fails, but `cluster-whisperer "question"` succeeds —
demonstrating the governance story without requiring a client-server architecture split.
A thin-client mode (CLI → serve endpoint) is deferred to a post-conference PRD.

## Success Criteria

- `cluster-whisperer --tools kubectl "question"` runs with only kubectl tools
- `cluster-whisperer --tools kubectl,vector,apply "question"` runs with all tools
- `cluster-whisperer --vector-backend qdrant "question"` uses Qdrant instead of Chroma
- `kubectl_apply` tool rejects resource types not found in the capabilities collection
- `kubectl_apply` tool applies resource types found in the capabilities collection
- Existing tests continue passing (no regressions)
- New tools have unit and integration tests
- Qdrant backend passes the same tests as ChromaBackend (interface compliance)
- OTel spans appear for Qdrant operations matching ChromaBackend's span patterns
- `CLUSTER_WHISPERER_TOOLS=kubectl cluster-whisperer "question"` works (env var support)
- Presenter's shell without KUBECONFIG: `kubectl get pods` fails, `cluster-whisperer "question"` succeeds
- Traces from locally-run agent appear in Jaeger/Datadog via in-cluster OTel Collector

## Non-Goals

- Vercel agent implementation (PRD #49)
- Demo cluster setup (PRD #47)
- Modifying existing LangGraph agent behavior
- Modifying existing ChromaBackend
- Thin-client mode (CLI → serve endpoint) — deferred to post-conference PRD
- Authentication on serve endpoints (internal network only)

## Milestones

### M1: kubectl_apply Core Tool
- [x] Core tool implementation (`src/tools/core/kubectl-apply.ts`)
- [x] YAML parsing to extract `kind` and `apiGroup` from input manifest
- [x] Catalog validation: query capabilities collection for the resource type
- [x] If not in catalog, return error to agent (tool-level enforcement, not prompt-level)
- [x] If in catalog, execute `kubectl apply -f -` via stdin
- [x] OTel span wrapping the apply operation
- [x] Unit tests for YAML parsing, catalog validation logic
- [x] Integration test against a real Kind cluster

### M2: kubectl_apply Framework Wrappers
- [x] LangChain tool wrapper (`src/tools/langchain/`)
- [x] MCP tool wrapper (`src/tools/mcp/`)
- [x] Investigator system prompt updated to explain when/how to use the apply tool (use `/write-prompt`)
- [x] Verified: agent can use the tool to deploy a resource in a test cluster

### M3: CLI Tool-Set Filtering (--tools flag)
- [x] `--tools` CLI flag accepting comma-separated tool groups: `kubectl`, `vector`, `apply`
- [x] Tool groups mapped to tool arrays in agent construction
- [x] Default: `kubectl,vector` (backwards compatible with current behavior)
- [x] Verified: `--tools kubectl` runs without vector or apply tools
- [x] Verified: `--tools kubectl,vector,apply` runs with all tools
- [x] Unit tests for tool-set parsing and filtering

### M4: Agent Selection Flag (--agent flag)
- [x] `--agent` CLI flag accepting `langgraph` (default) or `vercel`
- [x] Agent factory that constructs the right agent based on the flag
- [x] Initially only `langgraph` works; `vercel` returns "not yet implemented" error
- [x] Plumbing ready for PRD #49 to plug in the Vercel implementation

### M5: Qdrant VectorStore Backend
- [x] `QdrantBackend` implementing `VectorStore` interface (`src/vectorstore/qdrant-backend.ts`)
- [x] Filter syntax translation: convert `SearchOptions.where` to Qdrant `must`/`should`/`must_not` format
- [x] `keywordSearch` implementation using Qdrant's payload filtering
- [x] Use `/research` to verify current Qdrant JS/TS client API before implementation
- [x] Unit tests matching ChromaBackend test patterns
- [x] Integration tests against a real Qdrant instance

### M6: Vector Backend Switching (--vector-backend flag)
- [x] `--vector-backend` CLI flag accepting `chroma` (default) or `qdrant`
- [x] Backend factory that constructs the right VectorStore based on the flag
- [x] Verified: pipeline populates both backends with identical data
- [x] Verified: agent produces equivalent search results from both backends

### M7: OTel Instrumentation for Qdrant Backend
- [x] Every QdrantBackend operation wrapped in spans (matching ChromaBackend's pattern)
- [x] Span attributes: `db.system: "qdrant"`, `db.operation.name`, `db.collection.name`, custom counts
- [x] Unit tests verifying span creation (using in-memory OTel exporter, same pattern as ChromaBackend tests)
- [x] Verified: traces appear in Jaeger/Datadog when using Qdrant backend (moved to M8 — requires live cluster + OTel ingress)

### M8: Demo Runtime Readiness
- [x] Env var support for CLI flags: `CLUSTER_WHISPERER_AGENT`, `CLUSTER_WHISPERER_TOOLS`, `CLUSTER_WHISPERER_VECTOR_BACKEND` (Commander.js `.env()`)
- [x] Env var support for URL flags: `CLUSTER_WHISPERER_CHROMA_URL`, `CLUSTER_WHISPERER_QDRANT_URL`
- [x] `CLUSTER_WHISPERER_KUBECONFIG` env var: pass through to `executeKubectl()` as `--kubeconfig` arg
- [x] Kubeconfig pass-through also covers `kubectlApply` in `src/tools/core/kubectl-apply.ts` (has its own `spawnSync("kubectl", ...)` call that bypasses `executeKubectl()`)
- [x] Plumb kubeconfig path through agent factory → tool creation → kubectl execution
- [x] Unit tests for env var parsing and kubeconfig pass-through
- [x] Setup script: add Chroma ingress (`chroma.<ip>.nip.io` → port 8000)
- [x] Setup script: add Qdrant ingress (`qdrant.<ip>.nip.io` → port 6333)
- [x] Setup script: add OTel Collector ingress (`otel.<ip>.nip.io` → OTLP HTTP 4318)
- [x] Setup script: generate demo `.env` file with resolved ingress URLs (IP not known until after setup)
- [x] Serve manifest: add `--qdrant-url http://qdrant.qdrant:6333` to args
- [x] Verified: `kubectl get pods` fails without KUBECONFIG, `cluster-whisperer` succeeds with `CLUSTER_WHISPERER_KUBECONFIG`
- [x] Verified: traces from local CLI appear in Jaeger via OTel Collector ingress
- [x] M7 item 4: Verified Qdrant traces (`db.system: "qdrant"`) appear in Jaeger/Datadog

### M9: Multi-Backend Sync Pipeline
- [x] `MultiBackendVectorStore` class implementing `VectorStore` interface (`src/vectorstore/multi-backend.ts`)
- [x] Writes (`initialize`, `store`, `delete`) delegate to all backends in parallel via `Promise.all`
- [x] Reads (`search`, `keywordSearch`) delegate to first backend (wrapper is for sync writes only; demo agent reads from the audience-chosen backend via `CLUSTER_WHISPERER_VECTOR_BACKEND`)
- [x] Fail-fast: if any backend errors, the whole operation rejects
- [x] Unit tests for all delegated methods (`src/vectorstore/multi-backend.test.ts`)
- [x] Sync commands (`sync`, `sync-instances`) default to both backends when both URLs are available
- [x] Setup script: single sync invocation populates both Chroma and Qdrant
- [x] Setup script: verify Chroma has expected document count after sync
- [x] Setup script: verify Qdrant has expected document count after sync
- [ ] Verified: single `sync` invocation populates both backends with identical document counts

### M10: Full Demo Rehearsal

This is not a checklist of features — it is a full end-to-end rehearsal from teardown to traces. The authoritative demo flow is `docs/choose-your-adventure-demo.md`. If setup fails at any point, fix the root cause, teardown, and run setup again from scratch. No patching a half-built cluster.

- [ ] Teardown cluster (`demo/cluster/teardown.sh`) — can happen separately from setup (e.g., end of day)
- [ ] Run `demo/cluster/setup.sh gcp` from scratch — must exit 0 with no manual intervention (if this succeeds on first attempt, teardown + setup are both verified)
- [ ] Verify both vector databases are populated (Chroma and Qdrant have matching document counts)
- [ ] Source `demo/.env` — confirm infrastructure URLs are set
- [ ] Act 1: `kubectl get pods` fails (no KUBECONFIG in presenter shell)
- [ ] Act 2 setup: `export CLUSTER_WHISPERER_AGENT=langgraph` and `export CLUSTER_WHISPERER_TOOLS=kubectl`
- [ ] Act 2 question 1: `cluster-whisperer "Why is my app broken?"` — agent finds missing database
- [ ] Act 2 question 2: `cluster-whisperer "Can you help me fix this? Which database should I deploy?"` — agent sees 1,000+ CRDs, cannot identify the right one by name (CRD wall)
- [ ] Act 3 setup (Chroma): `export CLUSTER_WHISPERER_VECTOR_BACKEND=chroma` and `export CLUSTER_WHISPERER_TOOLS=kubectl,vector,apply`
- [ ] Act 3 (Chroma): `cluster-whisperer "What database should I deploy for my app, and can you set it up?"` — agent finds ManagedService via vector search, deploys it
- [ ] Act 3 cleanup: delete the deployed ManagedService instance
- [ ] Act 3 (Qdrant): `export CLUSTER_WHISPERER_VECTOR_BACKEND=qdrant` — repeat, agent finds and deploys ManagedService using Qdrant
- [ ] Act 4: open Jaeger UI — traces visible from agent runs
- [ ] Act 4 verification: traces include tool spans, vector search spans, and apply spans
- [ ] Full flow completes without errors, retries, or manual workarounds

### M11: Documentation
- [ ] Update README using `/write-docs` to document new CLI flags, env vars, and kubectl_apply tool
- [ ] Update `docs/choose-your-adventure-demo.md` to reflect env var interface (replaces old CLI flag commands)

## Technical Design

### kubectl_apply Tool — Catalog Validation

```text
Input: YAML manifest string
  ↓
Parse YAML → extract kind, apiGroup
  ↓
Query capabilities collection: vectorStore.keywordSearch("capabilities", undefined, { where: { kind, apiGroup } })
  ↓
Found? → kubectl apply -f - (via spawnSync, same as other kubectl tools)
Not found? → Return error: "Resource type {kind} ({apiGroup}) is not in the approved platform catalog. Cannot apply."
```

The validation uses `keywordSearch` with metadata filters (no embedding call needed).
This is the same "filters only" path that the vector_search tool already supports.

### Tool-Set Architecture

```text
CLI --tools flag
  ↓
Parse comma-separated groups: ["kubectl", "vector", "apply"]
  ↓
Map to tool arrays:
  kubectl → [kubectlGet, kubectlDescribe, kubectlLogs]
  vector  → [vectorSearch]
  apply   → [kubectlApply]
  ↓
Concatenate → pass to agent constructor
```

### Qdrant Filter Translation

The `SearchOptions.where` format follows Chroma's syntax (flat key-value pairs for
exact match). The QdrantBackend translates internally:

```text
Chroma format:  { kind: "Deployment", apiGroup: "apps" }
  ↓
Qdrant format:  { must: [
  { key: "kind", match: { value: "Deployment" } },
  { key: "apiGroup", match: { value: "apps" } }
]}
```

The `whereDocument` filter ($contains) translates to Qdrant's full-text search
or payload keyword matching.

### Demo Cluster Access

The PRD #47 demo cluster (GKE) uses a dedicated kubeconfig file, **not** the default `~/.kube/config`:

```text
KUBECONFIG path: ~/.kube/config-cluster-whisperer
Context name:    gke_demoo-ooclock_<zone>_cluster-whisperer-<timestamp>
```

To use it: `KUBECONFIG=~/.kube/config-cluster-whisperer kubectl get nodes`

This is set in `demo/cluster/setup.sh` (search for `KUBECONFIG_PATH`). The cluster has Crossplane CRDs, Chroma, Qdrant, the demo app, and synced capabilities/instances data. The default `~/.kube/config` may contain unrelated Kind clusters — always use the dedicated kubeconfig for demo cluster work.

### Demo Runtime Architecture (Option C)

```text
Presenter's terminal:
  - No KUBECONFIG exported → kubectl get pods fails
  - CLUSTER_WHISPERER_KUBECONFIG=~/.kube/config-cluster-whisperer
  - CLUSTER_WHISPERER_TOOLS=kubectl (after Vote 1)
  - CLUSTER_WHISPERER_VECTOR_BACKEND=qdrant (after Vote 2)
  - OTEL_EXPORTER_OTLP_ENDPOINT=http://otel.<ip>.nip.io

cluster-whisperer CLI:
  ├── Reads CLUSTER_WHISPERER_KUBECONFIG
  ├── Passes --kubeconfig to every executeKubectl() call
  ├── Agent runs locally with LangGraph streamEvents()
  ├── Vector DB accessed via ingress (chroma/qdrant.<ip>.nip.io)
  └── Traces exported to OTel Collector via ingress → Jaeger + Datadog
```

The presenter sources a `.env` file before the demo with infrastructure URLs only:
```bash
# Generated by setup.sh — contains resolved ingress IPs
source demo/.env
# Sets: CLUSTER_WHISPERER_KUBECONFIG, CLUSTER_WHISPERER_CHROMA_URL,
#        CLUSTER_WHISPERER_QDRANT_URL, OTEL_EXPORTER_OTLP_ENDPOINT
```

The audience-facing env vars are set **live on stage** after each vote — no defaults:
```bash
# Vote 1: audience picks framework
export CLUSTER_WHISPERER_AGENT=langgraph

# Vote 1 result → Act 2: investigation with kubectl tools only
export CLUSTER_WHISPERER_TOOLS=kubectl
cluster-whisperer "Why is my app broken?"
cluster-whisperer "Can you help me fix this? Which database should I deploy?"

# Vote 2: audience picks vector DB
export CLUSTER_WHISPERER_VECTOR_BACKEND=qdrant

# Vote 2 result → Act 3: full capability
export CLUSTER_WHISPERER_TOOLS=kubectl,vector,apply
cluster-whisperer "What database should I deploy for my app, and can you set it up?"

# Vote 3: audience picks observability UI → presenter opens that UI
```

### May Talk Preservation

All changes are additive:
- New files: `kubectl-apply.ts`, `qdrant-backend.ts`, `vercel.ts` wrappers
- Modified files: `index.ts` (CLI flags), `investigator.ts` (tool filtering)
- The default behavior (no flags) must match current behavior exactly

## Decision Log

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-03-07 | Tool-level catalog enforcement | Prompt-level guardrails aren't real security. The tool validates in code. |
| 2026-03-07 | `--tools` flag with groups, not individual tools | Groups match the demo narrative (progressive capability). Individual tool flags would clutter the CLI. |
| 2026-03-07 | Qdrant filter translation internal to backend | Keeps the VectorStore interface backend-agnostic. Callers never touch Qdrant syntax. |
| 2026-03-07 | Default behavior unchanged | May talk depends on current behavior. All new features require explicit flags. |
| 2026-03-13 | Kubeconfig pass-through (Option C) over thin-client mode (Option B) | Demo narrative needs "kubectl fails, agent succeeds" — achievable by passing kubeconfig internally via env var. Thin-client mode (CLI → serve endpoint) is better architecture but doesn't change what the audience sees, and PRD #49 (Vercel agent, making Vote 1 real) is higher priority than client-server split. Defer Option B to post-conference PRD. |
| 2026-03-13 | Env vars for CLI flags | Presenter sets env vars once after each audience vote instead of typing long flag combinations on stage. Cleaner demo experience, less error-prone. |
| 2026-03-13 | OTel Collector needs ingress | With agent running locally (Option C), traces must reach in-cluster OTel Collector externally. Add ingress rule in setup script. |
| 2026-03-13 | M7 OTel instrumentation already implemented in M5 | QdrantBackend spans were built alongside the backend implementation. 32 tests verify all span attributes. Live Jaeger/Datadog verification moved to M8 (requires running cluster). |
| 2026-03-13 | URL port parsing fix for ingress URLs | ChromaBackend and QdrantBackend defaulted to service ports (8000/6333) when no port in URL, breaking ingress URLs on port 80. Fixed to use protocol defaults (80/443). |
| 2026-03-13 | XRD renamed to opaque `managedservices.platform.acme.io` | Agent found `postgresqlinstances.platform.cluster-whisperer.io` by scanning CRD names, undermining the CRD wall narrative. The opaque name forces the agent to need vector search to discover the resource is a PostgreSQL database. |
| 2026-03-13 | Multi-backend sync via `MultiBackendVectorStore` wrapper | Setup script needs to populate both Chroma and Qdrant. Running LLM inference twice wastes API costs. Wrapper writes to all backends from a single pipeline run. |
| 2026-03-13 | Act 2 two-question flow | First question ("Why is my app broken?") finds the problem. Follow-up ("Can you help me fix this? Which database should I deploy?") triggers the CRD wall — agent sees 1,000+ opaque names and can't identify the database without semantic search. |
