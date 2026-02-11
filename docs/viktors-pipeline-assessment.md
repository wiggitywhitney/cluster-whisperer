# Viktor's Pipeline: Assessment for cluster-whisperer

Research into what Viktor's software does, how packaged it is, and what it would take for us to use it.

---

## What Viktor's Software Actually Is

Viktor has **two separate systems** that serve different purposes:

### System 1: Resource Sync (controller → Qdrant)

The `dot-ai-controller` (Go/Kubebuilder) watches nearly every resource in the cluster and syncs **instance-level metadata** to a `resources` collection in Qdrant. This tells the agent "what's running" — e.g., there's a Deployment named `nginx` in namespace `default` with labels `app=nginx`.

**What gets synced per resource**: namespace, name, kind, apiVersion, labels, description annotations, timestamps. No spec, no status.

**What gets embedded** (the text that becomes a vector):

```text
Deployment nginx | namespace: default | apiVersion: apps/v1 | group: apps | labels: env=prod
```

This is identity metadata, not semantic descriptions.

### System 2: Capability Inference (CRD schemas → LLM → Qdrant)

A separate pipeline analyzes CRD schemas and generates **type-level semantic descriptions** stored in a `capabilities` collection. This tells the agent "what things can do" — e.g., `sqls.devopstoolkit.live` provides postgresql/mysql/database capabilities with low complexity.

**How it works**:
1. Runs `kubectl explain <resource> --recursive` to get the CRD schema
2. Sends the schema to an LLM with a structured prompt (~120 lines of Handlebars template)
3. The LLM returns a JSON object with capabilities, providers, abstractions, complexity, description, useCase, and a confidence score
4. The result is embedded and stored in Qdrant

**What a capability entry looks like**:

```json
{
  "resourceName": "sqls.devopstoolkit.live",
  "apiVersion": "devopstoolkit.live/v1beta1",
  "capabilities": ["postgresql", "mysql", "database", "multi-cloud"],
  "providers": ["azure", "gcp", "aws"],
  "abstractions": ["high-availability", "persistent-storage", "backup"],
  "complexity": "low",
  "description": "Managed database solution supporting multiple engines",
  "useCase": "Simple database deployment without infrastructure complexity",
  "confidence": 0.85
}
```

**This is the system that matters for our Act 2 demo** — it's what lets the agent answer "how do I deploy a database?" by semantically searching capabilities.

### How They Work Together: The "Semantic Bridge"

The agent uses both collections in sequence:

1. User asks: "how do I deploy a database?"
2. Agent calls `search_capabilities("database")` → semantic search finds CRD types that relate to databases
3. Agent calls `query_resources` with filters for those kinds → finds actual instances running in the cluster
4. Agent synthesizes an answer

The capabilities collection bridges human concepts ("database") to Kubernetes resource types (`sqls.devopstoolkit.live`). The resources collection then finds actual instances of those types.

---

## How Packaged Is It?

### The Controller (`dot-ai-controller`)

**Very well packaged. Installable without cloning the repo.**

| Artifact | Location |
|----------|----------|
| Docker image | `ghcr.io/vfarcic/dot-ai-controller:v0.48.0` (multi-arch: amd64 + arm64) |
| Helm chart | `oci://ghcr.io/vfarcic/dot-ai-controller/charts/dot-ai-controller` |
| Releases | Automated on tag push, ~weekly cadence, v0.48.0 released Feb 10 2026 |

Install command:

```bash
helm install dot-ai-controller \
  oci://ghcr.io/vfarcic/dot-ai-controller/charts/dot-ai-controller \
  --version 0.48.0 \
  --namespace dot-ai --create-namespace
```

The Helm chart installs 5 CRDs, a ClusterRole with broad permissions (`*/*` get/list/watch), and a single-replica Deployment. Configuration is done entirely via Custom Resources (no env vars):

```yaml
# ResourceSyncConfig — tells the controller where to POST resource metadata
apiVersion: dot-ai.devopstoolkit.live/v1alpha1
kind: ResourceSyncConfig
metadata:
  name: default-sync
spec:
  mcpEndpoint: http://dot-ai:3456/api/v1/resources/sync
  mcpAuthSecretRef:
    name: dot-ai-secrets
    key: auth-token

# CapabilityScanConfig — tells the controller where to trigger capability scans
apiVersion: dot-ai.devopstoolkit.live/v1alpha1
kind: CapabilityScanConfig
metadata:
  name: default-scan
spec:
  mcp:
    endpoint: http://dot-ai:3456
    authSecretRef:
      name: dot-ai-secrets
      key: auth-token
```

**The controller is a pure HTTP client.** It doesn't know or care about Qdrant. It POSTs JSON to REST endpoints. Any server implementing those endpoints works.

### The MCP Server (`dot-ai`)

**Also well packaged, but heavier to deploy.**

| Artifact | Location |
|----------|----------|
| Docker image | `ghcr.io/vfarcic/dot-ai:latest` |
| Helm chart | In the `dot-ai` repo, `charts/` directory |
| npm package | `@vfarcic/dot-ai` |

The MCP server runs as a single process serving both MCP protocol (for AI clients) and REST API (for the controller) on the same port (3456).

**Required dependencies:**
- Qdrant instance (vector DB)
- LLM API key (Anthropic by default, configurable)
- OpenAI API key (for embeddings, configurable)
- Kubernetes access (kubeconfig)

**There's also an umbrella chart** (`dot-ai-stack`) that bundles everything:

```bash
helm install dot-ai oci://ghcr.io/vfarcic/dot-ai-stack/charts/dot-ai-stack \
  --namespace dot-ai --create-namespace \
  --set dot-ai.secrets.anthropic.apiKey="sk-..." \
  --set dot-ai.secrets.auth.token="my-shared-token"
```

This deploys the controller, MCP server, Qdrant, and auto-creates the ResourceSyncConfig and CapabilityScanConfig CRs.

---

## Option A: Use Viktor's Software As-Is (Qdrant Path)

### What This Gets Us

A fully populated Qdrant instance with:
- `resources` collection: all K8s resource instances (metadata)
- `capabilities` collection: AI-inferred semantic descriptions of every CRD

The agent can do semantic search over CRD capabilities and find running instances.

### What We'd Need to Do

1. Install the umbrella chart (or install controller + MCP server + Qdrant separately)
2. Configure API keys (Anthropic + OpenAI) via Kubernetes secrets
3. Wait for initial sync + capability scan to complete (~5 min for sync, ~5 min for capabilities on a ~66-resource cluster)
4. Point our agent's search tools at Qdrant

### Concerns

- **We don't control the data schema.** If we want to change what gets embedded or how capabilities are structured, we're modifying his code.
- **It's a lot of moving parts** for a teaching demo: Go controller + TypeScript MCP server + Qdrant + CRDs + RBAC.
- **Our agent would query Qdrant directly**, which means we'd need the Qdrant client SDK in our codebase. This is fine for the Qdrant path of the demo, but doesn't help with the Chroma path.
- **Understanding**: We wouldn't deeply understand the internals, which matters for a live presentation.

### Verdict

**This works for the Qdrant path of the demo.** Install, configure, run. The question is whether this is the path we build first, or whether we build the Chroma path first and add Qdrant later.

---

## Option B: Fork/Adapt Viktor's MCP Server for Chroma

### How Tightly Coupled Is Qdrant?

**Well-isolated.** Viktor built a clean plugin architecture:

- All business logic (`ResourceVectorService`, `CapabilityVectorService`, etc.) extends `BaseVectorService`, which calls through a plugin registry.
- All actual Qdrant SDK calls are isolated to **4 files** in `packages/agentic-tools/src/qdrant/`:
  - `client.ts` — singleton QdrantClient
  - `operations.ts` — all CRUD operations (store, search, query, delete, etc.)
  - `types.ts` — type definitions (VectorDocument, SearchResult, etc.)
  - `index.ts` — barrel export

### What Would Need to Change

**Must rewrite (Qdrant → Chroma):**

| File | What changes |
|------|-------------|
| `packages/agentic-tools/src/qdrant/client.ts` | Replace `QdrantClient` with `ChromaClient` |
| `packages/agentic-tools/src/qdrant/operations.ts` | Rewrite all operations using Chroma's API |
| `packages/agentic-tools/src/qdrant/types.ts` | Update types if Chroma shapes differ |
| `packages/agentic-tools/src/tools/qdrant-base.ts` | Rename, cosmetic |

**Must update (filter format leaks):**

| File | What changes |
|------|-------------|
| `src/core/base-vector-service.ts` | Filter type is documented as "Qdrant filter object" |
| `src/core/resource-vector-service.ts` | `buildQdrantFilter()` constructs Qdrant-specific syntax |
| `src/core/tracing/qdrant-tracing.ts` | Rename/update for Chroma |

**Qdrant filter syntax** vs **Chroma filter syntax**:

```javascript
// Qdrant
{ must: [{ key: "kind", match: { value: "Deployment" } }] }

// Chroma
{ kind: { $eq: "Deployment" } }
```

**Chroma-specific gaps:**
- Chroma doesn't have Qdrant's text index feature (`createPayloadIndex` with `field_schema: 'text'`). The keyword search half of hybrid search would need a different approach.
- Chroma's TypeScript SDK always requires a running Chroma server (no in-process mode like Python).

### Estimated Effort

~6-8 files to change. The core rewrite is the operations file (~300-400 lines). The filter format changes are scattered but small. Biggest risk is getting hybrid search (semantic + keyword) working equivalently in Chroma.

### Concerns

- **We'd be maintaining a fork** of Viktor's codebase. When he ships updates, we'd need to merge or diverge.
- **It's still his architecture.** We'd understand the Chroma adapter we wrote, but not necessarily the 30+ other files in the MCP server.
- **The fork would be specific to Chroma.** If we later want to show both Qdrant and Chroma, we'd need Viktor's original AND our fork.

### Verdict

**Doable but awkward.** We'd be maintaining a fork of a large codebase for a relatively small change. Better suited if we plan to contribute the Chroma adapter upstream.

---

## Option C: Build Our Own Lightweight Pipeline

### What We'd Actually Need to Build

Two components, matching Viktor's two systems:

**Component 1: Capability Inference (the important one for Act 2)**

The core of Viktor's capability inference is surprisingly small and extractable:
- `CapabilityInferenceEngine` class: ~200 lines
- Prompt template (`capability-inference.md`): ~120 lines
- Prompt loader: ~40 lines

The flow we'd replicate:
1. Run `kubectl api-resources` + `kubectl get crd -o json` to discover CRDs
2. For each CRD, run `kubectl explain <resource> --recursive`
3. Send the schema to an LLM with a structured prompt
4. Parse the JSON response (capabilities, providers, complexity, description, useCase)
5. Generate an embedding and store in Chroma

This is a script/tool, not a controller. Run it before the demo, or run it on startup.

**Performance**: ~4-6 seconds per resource (LLM inference time), so ~5 minutes for a 66-resource cluster. One LLM call + one embedding call per resource.

**Component 2: Resource Instance Sync (optional for Act 2)**

If the agent also needs to know what instances are running (not just what types exist), we'd need something like the resource sync. But our agent already has `kubectl` tools for this — it can run `kubectl get` at query time. The question is whether pre-loading instance data into the vector DB adds enough value for the demo.

### What This Looks Like

A TypeScript module in our repo that:
- Discovers CRDs in the cluster
- Runs LLM inference to generate capability descriptions
- Loads results into Chroma
- Exposes a semantic search function for the agent

**Estimated size**: 400-600 lines of TypeScript (not counting the prompt template). Significantly simpler than Viktor's full pipeline because:
- No plugin architecture (direct Chroma SDK calls)
- No session management or interactive workflows
- No circuit breaker or retry logic (we can add later if needed)
- No REST endpoint (the agent calls functions directly)
- No multi-provider embedding support (just OpenAI)

### Concerns

- **Duplicating work** that Viktor already did. The core inference logic is the same.
- **The prompt template is Viktor's IP.** We'd want to either reference his or write our own (which means different quality/results).
- **No real-time sync.** If CRDs are added during the demo, the vector DB won't automatically update. (Probably fine for a scripted demo.)

### Verdict

**Most appropriate for a teaching project.** Simple enough to explain on stage, small enough to understand fully, and directly targets what Act 2 needs (capability search in Chroma). We can always add Viktor's controller for the Qdrant path later.

---

## Option D: Hybrid — Viktor's Controller + Our Chroma Adapter

### The Idea

Use Viktor's controller as the sync trigger, but write our own lightweight REST endpoint that receives the POSTs and stores data in Chroma instead of Qdrant.

The controller is a pure HTTP client — it POSTs to whatever URL you configure. We'd need to implement two endpoints:

**Resource sync endpoint** (`POST /api/v1/resources/sync`):

```json
// Request
{ "upserts": [...], "deletes": [...], "isResync": false }
// Response
{ "success": true, "data": { "upserted": 5, "deleted": 1 } }
```

**Capability scan endpoint** (`POST /api/v1/tools/manageOrgData`):

```json
// Request
{ "dataType": "capabilities", "operation": "scan", "resourceList": "sqls.devopstoolkit.live" }
// Response
{ "success": true, "data": { ... } }
```

### What We'd Build

A small TypeScript HTTP server that:
1. Accepts the same JSON contract the controller expects
2. For resource sync: transforms and stores in Chroma
3. For capability scan: runs our own LLM inference and stores in Chroma

### Concerns

- **Still need the Go controller deployed** — same operational complexity as Option A.
- **Must implement the REST contract exactly** — the controller expects specific response formats.
- **Two moving parts**: Viktor's controller + our adapter server.
- **The capability scan trigger from the controller expects a fire-and-forget HTTP call.** We'd need to handle background processing.

### Verdict

**Over-engineered for a POC.** Adds the complexity of Viktor's controller without the simplicity of just using his full stack.

---

## Summary: Decision Matrix

| | Option A: Viktor's stack as-is | Option B: Fork for Chroma | Option C: Build our own | Option D: Hybrid |
|---|---|---|---|---|
| **Targets** | Qdrant path | Chroma path | Chroma path | Chroma path |
| **Setup effort** | Low (helm install) | Medium (fork + rewrite 6-8 files) | Medium (400-600 lines new code) | High (controller + adapter) |
| **Maintenance** | Viktor maintains it | We maintain a fork | We maintain it | We maintain adapter, Viktor maintains controller |
| **Understanding** | Low (it's a black box) | Medium (we understand the adapter layer) | High (we wrote it all) | Medium |
| **Teaching value** | Low | Low | High | Low |
| **Demo risk** | Low (battle-tested) | Medium (untested adapter) | Medium (new code) | High (two moving parts) |
| **Path to showing both DBs** | Already have Qdrant; build Chroma later | Have Chroma; add Viktor's stack for Qdrant later | Have Chroma; add Viktor's stack for Qdrant later | Have Chroma via adapter; add Qdrant via Viktor's stack |

---

## Open Question

The options aren't mutually exclusive. One possible path:

1. **Now**: Build our own lightweight capability inference + Chroma storage (Option C) — this is what we demo and teach
2. **Later**: Install Viktor's full stack (Option A) alongside it for the Qdrant path of the presentation
3. **On stage**: Show both approaches — "here's the simple version with Chroma, here's the production version with Qdrant and a real controller"

This gives us deep understanding of one path and Viktor's battle-tested software for the other. But this is a decision for you to make.
