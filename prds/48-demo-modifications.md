# PRD #48: Cluster-Whisperer Demo Modifications

**Status**: Not Started
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

## Solution

Add the new tool, CLI flags, and Qdrant backend as new files alongside existing code.
The three-layer tool architecture (`core/` → `langchain/` + `mcp/`) already supports
adding new tools. The `VectorStore` interface already supports backend swapping.

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

## Non-Goals

- Vercel agent implementation (PRD #49)
- Demo cluster setup (PRD #47)
- Modifying existing LangGraph agent behavior
- Modifying existing ChromaBackend

## Milestones

### M1: kubectl_apply Core Tool
- [ ] Core tool implementation (`src/tools/core/kubectl-apply.ts`)
- [ ] YAML parsing to extract `kind` and `apiGroup` from input manifest
- [ ] Catalog validation: query capabilities collection for the resource type
- [ ] If not in catalog, return error to agent (tool-level enforcement, not prompt-level)
- [ ] If in catalog, execute `kubectl apply -f -` via stdin
- [ ] OTel span wrapping the apply operation
- [ ] Unit tests for YAML parsing, catalog validation logic
- [ ] Integration test against a real Kind cluster

### M2: kubectl_apply Framework Wrappers
- [ ] LangChain tool wrapper (`src/tools/langchain/`)
- [ ] MCP tool wrapper (`src/tools/mcp/`)
- [ ] Investigator system prompt updated to explain when/how to use the apply tool (use `/write-prompt`)
- [ ] Verified: agent can use the tool to deploy a resource in a test cluster

### M3: CLI Tool-Set Filtering (--tools flag)
- [ ] `--tools` CLI flag accepting comma-separated tool groups: `kubectl`, `vector`, `apply`
- [ ] Tool groups mapped to tool arrays in agent construction
- [ ] Default: `kubectl,vector` (backwards compatible with current behavior)
- [ ] Verified: `--tools kubectl` runs without vector or apply tools
- [ ] Verified: `--tools kubectl,vector,apply` runs with all tools
- [ ] Unit tests for tool-set parsing and filtering

### M4: Agent Selection Flag (--agent flag)
- [ ] `--agent` CLI flag accepting `langgraph` (default) or `vercel`
- [ ] Agent factory that constructs the right agent based on the flag
- [ ] Initially only `langgraph` works; `vercel` returns "not yet implemented" error
- [ ] Plumbing ready for PRD #49 to plug in the Vercel implementation

### M5: Qdrant VectorStore Backend
- [ ] `QdrantBackend` implementing `VectorStore` interface (`src/vectorstore/qdrant-backend.ts`)
- [ ] Filter syntax translation: convert `SearchOptions.where` to Qdrant `must`/`should`/`must_not` format
- [ ] `keywordSearch` implementation using Qdrant's payload filtering
- [ ] Use `/research` to verify current Qdrant JS/TS client API before implementation
- [ ] Unit tests matching ChromaBackend test patterns
- [ ] Integration tests against a real Qdrant instance

### M6: Vector Backend Switching (--vector-backend flag)
- [ ] `--vector-backend` CLI flag accepting `chroma` (default) or `qdrant`
- [ ] Backend factory that constructs the right VectorStore based on the flag
- [ ] Verified: pipeline populates both backends with identical data
- [ ] Verified: agent produces equivalent search results from both backends

### M7: OTel Instrumentation for Qdrant Backend
- [ ] Every QdrantBackend operation wrapped in spans (matching ChromaBackend's pattern)
- [ ] Span attributes: `db.system: "qdrant"`, `db.operation.name`, `db.collection.name`, custom counts
- [ ] Unit tests verifying span creation (using in-memory OTel exporter, same pattern as ChromaBackend tests)
- [ ] Verified: traces appear in Jaeger/Datadog when using Qdrant backend

### M8: End-to-End Demo Flow Test
- [ ] Full demo flow against the demo cluster (PRD #47)
- [ ] Act 2: `--tools kubectl` — agent investigates, finds missing DB, hits CRD wall
- [ ] Act 3: `--tools kubectl,vector,apply --vector-backend chroma` — agent finds and deploys DB
- [ ] Act 3 (alt): same with `--vector-backend qdrant`
- [ ] Verify traces in both Jaeger and Datadog

### M9: Documentation
- [ ] Update README using `/write-docs` to document new CLI flags and kubectl_apply tool

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
