# cluster-whisperer

AI agent that investigates Kubernetes clusters and makes their capabilities searchable by natural language. Available as a CLI, MCP server, and REST API — with OpenTelemetry tracing throughout.

## What is this?

An AI agent that lets you ask questions about your Kubernetes cluster in plain English. It investigates using kubectl, searches a vector database of cluster knowledge, and explains what it finds. Available via **CLI** for direct terminal use, as an **MCP server** for integration with Claude Code, Cursor, and other MCP clients, or as a **REST API** for receiving live updates from a Kubernetes controller.

```bash
$ cluster-whisperer "Why are pods failing in the payments namespace?"

Thinking: I need to list pods in the payments namespace to see their current status...

🔧 Tool: kubectl_get
   Args: {"resource":"pods","namespace":"payments"}
   Result:
   NAME                      READY   STATUS             RESTARTS
   payments-api-7d4f9-x2k    0/1     CrashLoopBackOff   5

Thinking: The pod is in CrashLoopBackOff. Let me check the logs to see why...

🔧 Tool: kubectl_logs
   Args: {"pod":"payments-api-7d4f9-x2k","namespace":"payments"}
   Result:
Error: Cannot find module '/app/server.js'

────────────────────────────────────────────────────────────
Answer:
The payments-api pod is crashing because it can't find the entrypoint
file '/app/server.js'. This usually means the Docker image was built
incorrectly or the working directory is misconfigured.
```

The agent can also search the cluster's knowledge base to discover what's available — not just what's broken:

```bash
$ cluster-whisperer "What types of databases can I provision?"

Thinking: This is a question about available capabilities. Let me search
the vector database for database-related resource types...

🔧 Tool: vector_search
   Args: {"query":"managed database provisioning","collection":"capabilities"}
   Result:
   1. PostgreSQL (acid.zalan.do/v1) — Managed PostgreSQL clusters with
      automated failover, backups, and connection pooling. Complexity: high.
   2. SQL (devopstoolkit.live/v1) — Composite resource for managed SQL
      databases across cloud providers. Complexity: medium.

────────────────────────────────────────────────────────────
Answer:
Your cluster has two database-related resource types:
- PostgreSQL (Zalando operator) for managed PostgreSQL with automated
  failover and backups
- SQL (DevOps Toolkit) as a cloud-agnostic abstraction for managed
  databases
```

The first example shows **investigation** — the agent runs kubectl commands and reasons about what it finds. The second shows **discovery** — the agent searches pre-indexed cluster knowledge using semantic similarity, finding relevant resources even when the exact words don't match.

## How it works: The ReAct Pattern

This agent uses the **ReAct** pattern (Reasoning + Acting):

```text
Think → Act → Observe → Think → Act → Observe → ... → Answer
```

1. **Reason** - Agent thinks about what to do next
2. **Act** - Agent calls a tool (kubectl or vector search)
3. **Observe** - Agent sees the result
4. Repeat until the agent has enough information to answer

Note: "ReAct" is an AI agent pattern from a 2022 research paper. It has nothing to do with the React.js frontend framework.

## Features

- **CLI Agent** - Ask questions directly from the terminal with visible reasoning
- **MCP Server** - Use kubectl tools from Claude Code, Cursor, or any MCP-compatible client
- **REST API** - Receive live instance updates from a Kubernetes controller, keeping the vector database in sync automatically
- **Knowledge Pipeline** - Pre-index cluster capabilities and running instances into a vector database for semantic search
- **Vector Search** - Unified search tool with semantic, keyword, and metadata filtering — the agent uses this to discover what your cluster can do
- **OpenTelemetry Tracing** - Full observability with traces exportable to Datadog, Jaeger, etc.
- **Extended Thinking** - See the agent's reasoning process as it investigates

## Prerequisites

- Node.js 18+
- kubectl CLI installed and configured (for investigation and sync commands)
- `ANTHROPIC_API_KEY` environment variable (for the investigation agent and capability sync)
- `VOYAGE_API_KEY` environment variable (for vector database embedding)
- [Chroma](https://www.trychroma.com/) vector database running locally (for knowledge pipeline and vector search)

Not every command needs everything:

| Command | kubectl | Anthropic API Key | Voyage API Key | Chroma |
|---------|---------|-------------------|----------------|--------|
| `<question>` (investigate) | Yes | Yes | Optional | Optional |
| `sync` (capabilities) | Yes | Yes | Yes | Yes |
| `sync-instances` | Yes | No | Yes | Yes |
| `serve` (REST API) | No | Optional* | Yes | Yes |

*\*Required for the `/api/v1/capabilities/scan` endpoint. Without it, only instance sync is available.*

## Setup

```bash
npm install
npm run build
```

## Usage

### CLI Agent

```bash
# Run with vals to inject ANTHROPIC_API_KEY (-i inherits PATH so kubectl is found)
vals exec -i -f .vals.yaml -- node dist/index.js "What's running in the default namespace?"

# With tracing enabled (console output)
OTEL_TRACING_ENABLED=true \
vals exec -i -f .vals.yaml -- node dist/index.js "Find the broken pod"

# With tracing to Datadog (via local agent)
OTEL_TRACING_ENABLED=true \
OTEL_EXPORTER_TYPE=otlp \
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 \
vals exec -i -f .vals.yaml -- node dist/index.js "Find the broken pod"
```

### Knowledge Pipeline

The agent can pre-index cluster knowledge into a vector database for faster, more comprehensive answers.

**Sync resource capabilities** (what resource types exist and what they can do):

```bash
vals exec -i -f .vals.yaml -- node dist/index.js sync
```

**Sync resource instances** (what's currently running in the cluster):

```bash
vals exec -i -f .vals.yaml -- node dist/index.js sync-instances

# Preview what would be synced without writing to the database
vals exec -i -f .vals.yaml -- node dist/index.js sync-instances --dry-run
```

Together these enable the **"Semantic Bridge" pattern**: capabilities tell the agent what's *possible*, instances tell it what *exists*. When a user asks "what databases are running?", the agent searches capabilities to find database-related resource types, then searches instances filtered to those types to find actual running resources.

See `docs/capability-inference-pipeline.md` and `docs/resource-instance-sync.md` for details.

### MCP Server (Claude Code, Cursor, etc.)

Add to your `.mcp.json` (in project root or `~/.claude/`):

```json
{
  "mcpServers": {
    "cluster-whisperer": {
      "command": "node",
      "args": ["/path/to/cluster-whisperer/dist/mcp-server.js"],
      "env": {
        "OTEL_TRACING_ENABLED": "true",
        "OTEL_EXPORTER_TYPE": "otlp",
        "OTEL_EXPORTER_OTLP_ENDPOINT": "http://localhost:4318"
      }
    }
  }
}
```

**Note**: Use an absolute path in `args`. MCP clients spawn the server as a subprocess, and relative paths resolve from the client's working directory.

See `docs/mcp-server.md` for details on how MCP works.

### REST API

Start the HTTP server to receive instance sync payloads from a Kubernetes controller:

```bash
vals exec -i -f .vals.yaml -- node dist/index.js serve

# Custom port
vals exec -i -f .vals.yaml -- node dist/index.js serve --port 8080
```

The server exposes:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/healthz` | GET | Liveness probe — always returns 200 if the process is running |
| `/readyz` | GET | Readiness probe — returns 200 only when Chroma is reachable |
| `/api/v1/instances/sync` | POST | Receives batched instance upserts and deletes |
| `/api/v1/capabilities/scan` | POST | Triggers capability inference for specific CRDs (optional — requires `ANTHROPIC_API_KEY`) |

The instance sync endpoint accepts a JSON payload with two arrays:

```json
{
  "upserts": [
    {
      "id": "default/apps/v1/Deployment/nginx",
      "namespace": "default",
      "name": "nginx",
      "kind": "Deployment",
      "apiVersion": "apps/v1",
      "apiGroup": "apps",
      "labels": {},
      "annotations": {},
      "createdAt": "2025-01-15T10:30:00Z"
    }
  ],
  "deletes": ["default/apps/v1/Deployment/old-nginx"]
}
```

The capability scan endpoint accepts a list of fully qualified CRD resource names:

```json
{
  "upserts": ["certificates.cert-manager.io", "issuers.cert-manager.io"],
  "deletes": ["old-resource.example.io"]
}
```

Unlike instance sync (which returns 200 synchronously), the capability scan returns 202 Accepted immediately and processes in the background — LLM inference takes ~4-6 seconds per resource. See `docs/capability-inference-pipeline.md` for details.

Both endpoints are designed to work with the [k8s-vectordb-sync](https://github.com/wiggitywhitney/k8s-vectordb-sync) controller, which watches Kubernetes clusters for resource and CRD changes and pushes them here. Any client can POST to either endpoint — the contract is the JSON schema above.

The server handles graceful shutdown on SIGTERM, making it Kubernetes-deployment friendly.

## Architecture

cluster-whisperer exposes kubectl and vector search tools via three interfaces:

### CLI Agent

```text
User Question → ReAct Agent → [kubectl + vector search tools] → Cluster / Vector DB → Answer
                    ↑                       |
                    └───────────────────────┘
                   (agent sees result,
                    decides next action)
```

The CLI agent has its own reasoning loop - it decides which tools to call and interprets the results.

### MCP Server

```text
User Question → [Claude Code / Cursor] → MCP → investigate tool → ReAct Agent → Cluster / Vector DB
                                                      ↑                  |
                                                      └──────────────────┘
                                                     (agent reasons internally)
```

The MCP server exposes a single `investigate` tool that wraps the same ReAct agent used by the CLI. This gives MCP clients complete investigations with full tracing - one call captures the entire reasoning chain.

### REST API

```text
k8s-vectordb-sync controller
        |
        ├── POST /api/v1/instances/sync      (resource changes)
        ├── POST /api/v1/capabilities/scan   (CRD changes)
        v
cluster-whisperer serve (Hono server) → Vector DB
        ^
        |
Kubernetes cluster ──(watches)──┘
```

The REST API receives pushed data from the [k8s-vectordb-sync](https://github.com/wiggitywhitney/k8s-vectordb-sync) controller. Instance sync keeps the vector database up-to-date as resources change. Capability scan triggers LLM inference when new CRDs are installed, so the agent discovers new resource types automatically.

### Available Tools

**CLI Agent**: Uses these tools internally during investigation:
- `kubectl_get` - List resources and their status
- `kubectl_describe` - Get detailed resource information
- `kubectl_logs` - Check container logs
- `vector_search` - Search the vector database with three composable dimensions:
  - **Semantic search** (`query`) — natural language similarity via embeddings (e.g., "managed database" finds SQL CRDs)
  - **Keyword search** (`keyword`) — exact substring match, no embedding call (e.g., "backup" finds docs mentioning backup)
  - **Metadata filters** (`kind`, `apiGroup`, `namespace`, `complexity`) — exact match on structured fields

  The agent uses kubectl tools for **investigation** ("why is this pod failing?") and vector search for **discovery** ("what databases can I provision?").

**MCP Server**: Exposes a single high-level tool:
- `investigate` - Ask a question, get a complete answer (wraps the ReAct agent with all tools above)

## Observability

OpenTelemetry tracing provides visibility into agent operations. OTel SDK packages are **optional peer dependencies** — tracing works when installed but everything runs fine without them. See [`docs/opentelemetry.md`](docs/opentelemetry.md) for installation and configuration details.

```text
cluster-whisperer.investigate (root span)
├── kubectl_get.tool
│   └── kubectl get pods -n default
├── kubectl_describe.tool
│   └── kubectl describe pod broken-pod
├── kubectl_logs.tool
│   └── kubectl logs broken-pod
└── vector_search.tool
    └── query: "managed database provisioning"
```

**Environment Variables:**

| Variable | Default | Description |
|----------|---------|-------------|
| `OTEL_TRACING_ENABLED` | `false` | Enable tracing |
| `OTEL_EXPORTER_TYPE` | `console` | `console` or `otlp` |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | - | OTLP collector URL (e.g., `http://localhost:4318`) |
| `OTEL_CAPTURE_AI_PAYLOADS` | `false` | Capture tool inputs/outputs in traces |
| `VOYAGE_API_KEY` | - | Voyage AI API key (required by sync, sync-instances, and serve) |
| `CHROMA_URL` | `http://localhost:8000` | Chroma vector database URL |

**Schema Validation:**

Custom span attributes (`cluster_whisperer.*`, `traceloop.*`, `gen_ai.*`) are formally defined in a [Weaver](https://github.com/open-telemetry/weaver) registry at `telemetry/registry/attributes.yaml`. This is the single source of truth for attribute names, types, and descriptions. Weaver validates the schema and resolves references to OTel semantic conventions:

```bash
npm run telemetry:check     # Validate registry structure and references
npm run telemetry:resolve   # Resolve all references to flat JSON
```

See `docs/tracing-conventions.md` for tracing architecture, context propagation, and design rationale.

## Project Structure

```text
src/
├── index.ts               # CLI entry point (agent + sync + serve commands)
├── mcp-server.ts          # MCP server entry point
├── agent/
│   └── investigator.ts    # ReAct agent setup (LangGraph)
├── api/                   # REST API for controller-pushed sync
│   ├── server.ts          # Hono HTTP server with health probes
│   ├── routes/
│   │   ├── instances.ts   # POST /api/v1/instances/sync endpoint
│   │   └── capabilities.ts # POST /api/v1/capabilities/scan endpoint
│   └── schemas/
│       ├── sync-payload.ts # Zod validation for instance sync payloads
│       └── scan-payload.ts # Zod validation for capability scan payloads
├── pipeline/              # Knowledge sync pipelines
│   ├── discovery.ts       # Resource type discovery (kubectl api-resources)
│   ├── inference.ts       # Capability inference (kubectl explain → LLM)
│   ├── storage.ts         # Capability document storage
│   ├── runner.ts          # Capability sync orchestrator
│   ├── instance-discovery.ts  # Resource instance discovery (kubectl get)
│   ├── instance-storage.ts    # Instance document storage
│   └── instance-runner.ts     # Instance sync orchestrator
├── vectorstore/           # Vector database abstraction
│   ├── types.ts           # VectorStore interface
│   ├── chroma-backend.ts  # Chroma implementation
│   └── embeddings.ts      # Voyage AI embedding provider
├── tools/
│   ├── core/              # Shared tool logic (schemas, execution)
│   │   ├── kubectl-get.ts
│   │   ├── kubectl-describe.ts
│   │   ├── kubectl-logs.ts
│   │   ├── vector-search.ts   # Unified semantic/keyword/metadata search
│   │   └── format-results.ts  # Search result formatting
│   ├── langchain/         # CLI agent wrappers
│   └── mcp/               # MCP server wrappers
├── tracing/               # OpenTelemetry instrumentation
│   ├── index.ts           # OTel initialization, exporter setup
│   ├── context-bridge.ts  # AsyncLocalStorage workaround for LangGraph
│   ├── tool-tracing.ts    # Tool span wrapper
│   ├── tool-definitions-processor.ts  # Adds tool definitions to LLM spans
│   └── optional-deps.ts   # Graceful loading of optional OTel packages
└── utils/
    └── kubectl.ts         # Shared kubectl execution helper

prompts/
├── investigator.md        # Agent system prompt (investigation behavior)
└── capability-inference.md # Capability inference prompt (sync pipeline)

telemetry/
└── registry/              # OpenTelemetry Weaver schema
    ├── attributes.yaml    # Custom attribute definitions
    └── registry_manifest.yaml  # Schema metadata + OTel semconv dependency

scripts/
└── seed-test-data.ts      # Load sample data into Chroma for testing

docs/
├── agentic-loop.md                  # How the ReAct agent works
├── capability-inference-pipeline.md # How capability sync works
├── kubectl-tools.md                 # How kubectl tools work
├── langgraph-vs-langchain.md        # LangChain vs LangGraph explained
├── mcp-server.md                    # MCP server architecture
├── opentelemetry.md                 # OpenTelemetry implementation guide
├── resource-instance-sync.md        # How instance sync works
├── tracing-conventions.md           # Tracing architecture and design rationale
└── vector-database.md               # Vector database architecture
```

## License

MIT
