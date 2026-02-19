# Capability Inference Pipeline

This document explains how cluster-whisperer discovers what a Kubernetes cluster can do and makes that knowledge searchable.

---

## The Problem

A Kubernetes cluster with Crossplane, operators, or other extensions can have hundreds of CRDs. Their names alone (e.g., `instances.rds.aws.upbound.io`, `clusters.neptune.aws.upbound.io`) don't tell a developer what they do, which cloud providers they support, or how complex they are.

When someone asks "how do I deploy a database?", the agent needs to know that `instances.rds.aws.upbound.io` is a managed database — even though the word "database" doesn't appear in the resource name.

## The Solution

The capability inference pipeline translates raw CRD schemas into human-understandable descriptions, then stores them in the vector database for semantic search.

```text
kubectl explain <resource> --recursive
        |
        v
   LLM analyzes the schema
        |
        v
   Structured capability description (JSON)
        |
        v
   Stored in vector database as searchable document
        |
        v
   Agent can now find this resource by meaning
```

## Running the Pipeline

### Prerequisites

1. **Kubernetes cluster access** — a valid kubeconfig pointing at the target cluster
2. **Chroma server running** — the vector database backend
3. **API keys** — `ANTHROPIC_API_KEY` and `VOYAGE_API_KEY`

### Start Chroma

```bash
chroma run --path ./chroma-data
```

### Run the Sync

```bash
# Set API keys (via vals or direct export)
export ANTHROPIC_API_KEY=your-key
export VOYAGE_API_KEY=your-key

# Sync all resource types to the vector database
npx tsx src/index.ts sync

# Preview what would be synced without storing
npx tsx src/index.ts sync --dry-run

# Use a different Chroma server
npx tsx src/index.ts sync --chroma-url http://chroma.example.com:8000
```

### What Happens During a Sync

1. **Discovery** — runs `kubectl api-resources -o wide` to list all resource types, then `kubectl explain <resource> --recursive` to extract each schema. Filters out low-value resources (Events, Leases, EndpointSlices, subresources) and resources without `get` verb.

2. **Inference** — sends each schema to Claude Haiku with a structured prompt. The LLM analyzes the schema and returns: capabilities (what it does), providers (which clouds), complexity (low/medium/high), description, use case, and confidence score.

3. **Storage** — converts each capability into a vector database document with embedding text and metadata, then upserts into the `capabilities` collection via the VectorStore interface.

Progress is logged as the pipeline runs:
```text
Starting capability sync...
Discovering API resources...
Found 166 API resources.
After filtering: 153 resources (removed 13).
Extracting schema (1 of 153): configmaps
...
Inference complete: 153 of 153 resources processed.
Storage complete: 153 capabilities stored in "capabilities" collection.
Sync complete: 153 discovered, 153 inferred, 153 stored.
```

### Re-running

The sync uses upsert — re-running is safe and updates existing entries. There is no incremental diff; every sync processes all resources. A full sync of ~150 resources takes a few minutes (schema extraction is fast, LLM inference is the bottleneck).

## What Gets Stored

### Capability Data Structure

Each resource type produces one `ResourceCapability`:

```typescript
interface ResourceCapability {
  resourceName: string;      // "instances.rds.aws.upbound.io"
  apiVersion: string;        // "rds.aws.upbound.io/v1beta3"
  group: string;             // "rds.aws.upbound.io"
  kind: string;              // "Instance"
  capabilities: string[];    // ["rds", "database", "mysql", "postgresql", ...]
  providers: string[];       // ["aws"]
  complexity: "low" | "medium" | "high";
  description: string;       // "AWS RDS database instance supporting multiple engines..."
  useCase: string;           // "Deploy and manage a fully-managed relational database..."
  confidence: number;        // 0.92
}
```

### Embedding Text

The text that gets vectorized (embedded) for semantic search is constructed from capability fields:

```text
Instance (rds.aws.upbound.io)
Capabilities: rds, database, mysql, postgresql, mariadb, oracle, sql-server, managed-database, backup, replication, multi-az, encryption, monitoring.
Providers: aws. Complexity: high.
AWS RDS database instance supporting multiple engines (MySQL, PostgreSQL, MariaDB, Oracle, SQL Server) with configurable storage, backups, replication, encryption, and monitoring.
Use case: Deploy and manage a fully-managed relational database instance on AWS with automated backups, multi-AZ failover, and encryption at rest.
```

This format puts the most semantically important information (capabilities, description) in the text so vector similarity works well.

### Metadata

Each document also stores metadata for exact-match filtering:

| Field | Example | Use |
|-------|---------|-----|
| `kind` | `Instance` | Filter by resource kind |
| `apiGroup` | `rds.aws.upbound.io` | Filter by API group |
| `apiVersion` | `rds.aws.upbound.io/v1beta3` | Full API version |
| `complexity` | `high` | Filter by complexity level |
| `providers` | `aws` | Comma-separated provider list |
| `confidence` | `0.92` | LLM's confidence in its analysis |
| `resourceName` | `instances.rds.aws.upbound.io` | Fully qualified resource name |

## Architecture

```text
src/pipeline/
├── types.ts        # Data structures (DiscoveredResource, ResourceCapability, etc.)
├── discovery.ts    # M1: kubectl api-resources + kubectl explain
├── inference.ts    # M2: LLM schema analysis via Haiku + Zod structured output
├── storage.ts      # M3: VectorStore document construction and upsert
├── runner.ts       # M4: Orchestrates discover → infer → store
└── index.ts        # Barrel exports

prompts/
└── capability-inference.md   # LLM prompt template for schema analysis
```

All pipeline stages use dependency injection for testability — the kubectl executor, LLM model, and vector store are all injectable, so unit tests can mock system boundaries while integration tests use real services.

## How the Agent Uses Capabilities

Once capabilities are synced, the investigator agent has a `vector_search` tool that queries the `capabilities` collection. When a user asks a discovery question like "how do I deploy a database?", the agent:

1. Searches capabilities with a semantic query (e.g., "managed database")
2. Gets back ranked results with descriptions and metadata
3. Optionally verifies with kubectl (e.g., checks if the provider is actually running)
4. Recommends the best resource type with usage guidance

See `docs/vector-database.md` for details on the search tool's three dimensions (semantic, keyword, metadata filter).
