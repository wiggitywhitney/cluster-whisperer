# PRD #25: Capability Inference Pipeline

**Status**: Not Started
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

- [ ] Pipeline discovers CRDs and API resources from a live cluster
- [ ] LLM analyzes each resource schema and produces structured capability descriptions
- [ ] Capability descriptions are stored in the vector database via PRD #7's interface
- [ ] Agent can semantically search capabilities (e.g., "database" finds `sqls.devopstoolkit.live`)
- [ ] Pipeline is vector-DB-agnostic (works with Chroma now, Qdrant later)
- [ ] Documentation explains how the inference pipeline works

## Milestones

- [ ] **M1**: CRD Discovery
  - Discover all CRDs and API resources in the cluster
  - Extract schema information for each (via `kubectl explain --recursive` or K8s API)
  - Filter out low-value resources (Events, Leases, EndpointSlices, subresources)
  - Output: a list of resources with their schema text, ready for LLM analysis

- [ ] **M2**: LLM Inference Pipeline
  - Design the prompt template for capability inference
  - Send resource schemas to the LLM, parse structured JSON responses
  - Define the `ResourceCapability` data structure (capabilities, providers, complexity, description, useCase)
  - Handle LLM errors and validation of responses
  - Output: structured capability descriptions for each resource

- [ ] **M3**: Storage and Search
  - Store capability descriptions in the vector DB via PRD #7's interface
  - Construct embedding text from capability fields (name + capabilities + description + useCase)
  - Store metadata for filtering (kind, apiGroup, complexity, providers)
  - Verify semantic search works: "database" → finds database-related CRDs
  - Verify filter search works: "all low-complexity resources" → filters by metadata

- [ ] **M4**: CLI Tool / Runner
  - Wrap the pipeline as a runnable tool (CLI command, npm script, or startup hook)
  - Support scanning all resources or a specific subset
  - Log progress (N of M resources scanned)
  - Handle incremental updates (re-scan only changed/new CRDs, or full rescan)

- [ ] **M5**: End-to-End Demo Validation
  - Load capabilities from the demo cluster (with many database CRDs installed)
  - Test the full flow: user asks "how do I deploy a database?" → agent searches capabilities → finds the right CRD → recommends it
  - Document the pipeline setup and usage

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

- Exact prompt template wording (will iterate during M2)
- Whether to use `kubectl explain` via subprocess or the Kubernetes API directly
- Whether to run inference sequentially or in parallel (sequential is simpler, parallel is faster)
- How to handle resources where `kubectl explain` returns minimal information
- Whether the runner is a standalone CLI, an npm script, or integrated into the MCP server startup

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

*Decisions will be logged here as they're made during implementation.*

---

## Progress Log

*Progress will be logged here as milestones are completed.*
