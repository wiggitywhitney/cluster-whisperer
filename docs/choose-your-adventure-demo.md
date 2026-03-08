# Choose Your Own Adventure: KubeCon Demo Flow

This document captures the complete demo flow, technical architecture, and design
decisions for the "Choose Your Own Adventure" KubeCon talk. The audience votes at
three decision points, and each vote changes the technology powering the demo.

---

## The Story

A developer's app is broken in production. Their company runs an Internal Developer
Platform on Kubernetes, but direct cluster access isn't allowed — too risky. The
developer only has their AI coding assistant.

The demo progressively adds capability:

1. **No agent** — the developer is blind
2. **Agent with kubectl tools** — the developer can see, but can't navigate complexity
3. **Agent with semantic search + deploy** — the developer can see, understand, and act
4. **Observability** — the platform team can see what the agent did

---

## Demo Flow

### Setup (before the demo starts)

- Kind cluster running with Crossplane installed
- Monolithic `provider-aws` + `provider-gcp` installed (1,200+ CRDs, no cloud credentials needed)
- One Crossplane Composition/XRD defining the platform team's approved PostgreSQL database
- Demo app deployed and in CrashLoopBackOff (expects `DATABASE_URL`, no database exists)
- Both Chroma and Qdrant pre-deployed and pre-populated (via capability inference pipeline + k8s-vectordb-sync)
- Jaeger and Datadog Agent (OTLP receiver) both running
- OTel tracing enabled, exporting to both backends

### Act 1: No Agent

The developer asks Claude Code: "My app is broken, help me figure out why."

Claude Code has no MCP server configured. It can read the app's source code, see
`DATABASE_URL` in the configuration, and guess there might be a database connection
issue. But it **cannot see the cluster**. It can't confirm anything. Dead end.

> "What if we gave our coding assistant a way to actually talk to the cluster?"

### Vote 1: Agent Framework — LangGraph or Vercel AI SDK?

The audience chooses which agent framework to use.

### Act 2: Agent with kubectl Tools

The developer runs the agent via CLI (not MCP — CLI shows the agent's reasoning live
so the audience can watch it think):

```bash
cluster-whisperer --agent langgraph --tools kubectl "Why is my app broken?"
```

The agent:
1. Uses `kubectl_get` — finds pods in CrashLoopBackOff
2. Uses `kubectl_describe` — sees connection refused to database service
3. Uses `kubectl_logs` — confirms "ECONNREFUSED" to postgres
4. Concludes: no database deployed

Developer asks: "What database should I deploy?"

Agent tries `kubectl_get crds` — gets a wall of 1,200+ cryptic CRD names. It has no
understanding of what these resources do. It cannot recommend one over another.

> "The agent can see the cluster, but it can't make sense of the platform's capabilities.
> We need to give it semantic understanding."

### Vote 2: Vector Database — Chroma or Qdrant?

The audience chooses which vector database backend to connect.

### Act 3: Agent with Semantic Search + Deploy

The developer runs the agent with the full tool set:

```bash
cluster-whisperer --agent langgraph --tools kubectl,vector,apply \
  --vector-backend chroma \
  "What database should I deploy for my app, and can you set it up?"
```

The agent:
1. Uses `vector_search` on the capabilities collection — searches for "PostgreSQL database for application"
2. Finds the platform team's approved Composition among 1,200+ CRDs
3. Explains what it does and why it's the right choice
4. Generates a manifest for the CompositeResource
5. Uses `kubectl_apply` — the tool validates the resource type exists in the approved catalog before applying
6. Database comes up, app connects, app works

> "The agent found the right resource out of over a thousand options because it has
> semantic understanding of what each one does. And it could only deploy resources
> from the approved catalog — the platform team controls what's allowed."

### Vote 3: Observability Backend — Jaeger or Datadog?

The audience chooses where to look at traces.

### Act 4: Traces

"Everything was instrumented with OpenTelemetry the whole time. Let's see what the
agent actually did."

Open whichever backend the audience chose. Show the full investigation trace:
- Every LLM reasoning step
- Every tool call (kubectl commands, vector searches)
- The deploy operation
- Token usage, latency, tool execution times

---

## Technical Architecture

### Agent Implementations

Two agent implementations sharing the same tool core:

```text
src/tools/core/           ← Shared business logic (kubectl, vector search, apply)
src/tools/langchain/      ← LangGraph tool wrappers (existing)
src/tools/vercel/         ← Vercel AI SDK tool wrappers (new)
src/agent/investigator.ts ← LangGraph agent (existing)
src/agent/vercel.ts       ← Vercel AI SDK agent (new)
```

CLI selects the agent via `--agent langgraph|vercel` flag.

### Tool Sets

Tools are grouped and filtered via `--tools` CLI flag:

| Flag | Tools Included |
|------|----------------|
| `kubectl` | kubectl_get, kubectl_describe, kubectl_logs |
| `vector` | vector_search (semantic + keyword + metadata) |
| `apply` | kubectl_apply (with catalog validation) |

### kubectl_apply Tool — Catalog Validation

The `kubectl_apply` tool enforces platform policy **in code, not in the prompt**:

1. Parse incoming YAML to extract `kind` and `apiGroup`
2. Query the capabilities collection — is this resource type in the catalog?
3. If **not found**: return error `"Resource type X is not in the approved platform catalog"`
4. If **found**: run `kubectl apply -f -`

The agent cannot bypass this — it's the tool's execution path.

### Vector Database Backend Switching

The existing `VectorStore` interface supports this without pipeline changes:

```text
--vector-backend chroma   → ChromaBackend (existing)
--vector-backend qdrant   → QdrantBackend (new)
```

Both backends are pre-deployed and pre-populated. The pipeline (`storage.ts`,
`instance-storage.ts`) only touches the `VectorStore` interface — zero Chroma-specific
code in the pipeline. The Qdrant backend translates filter syntax internally.

### Observability

Both backends receive traces simultaneously via OTLP:
- Jaeger: running in-cluster
- Datadog Agent: running in-cluster with OTLP receiver on port 4318

The Vercel AI SDK has built-in OTel (`experimental_telemetry: { isEnabled: true }`)
creating `ai.generateText`, `ai.toolCall` spans natively. Simpler than LangGraph's
instrumentation (no OpenLLMetry SDK or context bridge workaround needed).

### Demo Cluster

A Kind cluster with setup/teardown scripts in `demo/`:

| Component | Purpose |
|-----------|---------|
| Crossplane + provider-aws + provider-gcp | 1,200+ CRDs for the "overwhelming" moment |
| Platform Composition/XRD | The one right answer for PostgreSQL |
| Demo app (Deployment + Service) | CrashLoopBackOff without database |
| Chroma (Helm) | Vector DB option A |
| Qdrant (Helm) | Vector DB option B |
| Jaeger (Helm) | Observability option A |
| Datadog Agent (Helm) | Observability option B |
| k8s-vectordb-sync | Populates vector DBs with cluster data |
| cluster-whisperer serve | Receives sync data from controller |

Setup script creates everything. Teardown script destroys the Kind cluster.

---

## Key Design Decisions

### CLI over MCP for the demo
MCP hides the agent's reasoning inside Claude Code. CLI streams thinking, tool calls,
and observations live — the audience sees the agent work. Frame it: "In production,
this runs as an MCP server in your coding assistant. For today, I'm running it directly
so you can see it think."

### The framework doesn't matter — and that's the point
Both agents produce the same investigation experience. The audience picks a framework,
but the demo looks identical either way. This IS the message: "The pattern — an AI
agent as a platform interface — works the same regardless of the underlying technology."

### Pre-deployed, not live-installed
Both vector databases and both observability backends are pre-deployed. Votes switch
which one the agent connects to (a CLI flag), not which one gets installed. No risky
live installs on stage.

### Only the agent has cluster access
Claude Code itself has no kubeconfig. The cluster-whisperer CLI process has the
kubeconfig. The platform team controls what tools the agent has — that's the guardrail.

### Crossplane CRDs without cloud credentials
Installing `provider-aws` and `provider-gcp` registers all CRDs without needing
AWS/GCP credentials. The CRDs are discoverable by the capability inference pipeline
and searchable in the vector DB, even though they can't actually provision cloud
resources. Perfect for the demo.

---

## Relationship to May Talk

The May conference abstract covers cluster-whisperer as-is: LangGraph + Chroma + OTel,
single technology stack, live demo. The "Choose Your Own Adventure" work adds:

- Vercel agent implementation (new files, not modifications)
- Qdrant backend (new VectorStore implementation)
- kubectl_apply tool (new tool)
- Tool set filtering (CLI flag addition)
- Demo cluster scripts (new directory)
- Demo app (new directory)

These are **additions**, not modifications to existing code. The existing LangGraph +
Chroma flow must continue working unchanged.

---

## PRD Breakdown (Execution Order)

| Order | PRD | Scope | Dependencies |
|-------|-----|-------|--------------|
| 1 | #50 Abstract rewrite | Interactive milestone — requires back-and-forth | None |
| 2 | #46 Demo app | Small app with DATABASE_URL dependency, Dockerfile, K8s manifests | None |
| 3 | #47 Demo cluster setup/teardown | Kind cluster with all components, setup/teardown scripts | #46 Demo app |
| 4 | #48 Cluster-whisperer modifications | kubectl_apply tool, --tools flag, --agent flag, --vector-backend flag, Qdrant backend, OTel for Qdrant | #47 Demo cluster for testing |
| 5 | #49 Vercel agent | Research phase first (AI SDK 6 ToolLoopAgent), implementation, OTel instrumentation | #48 Cluster-whisperer modifications (shared tool core) |

Note: PRD #49 M1 (research) can start during PRD #48 implementation.
