# Choose Your Own Adventure: KubeCon Demo Flow

This is a KubeCon talk called "Choose Your Own Adventure." The core idea: the audience
votes on technology choices during a live demo, and those votes change what's running on
stage. The message is that the pattern — using an AI agent as a developer's interface to
a Kubernetes platform — works regardless of which specific technologies you pick.

---

## Setup (before the demo starts)

Run one setup script that creates a GKE cluster with everything pre-deployed — both
agents, both vector databases, both observability backends, ~1,000 Crossplane CRDs, and
an intentionally broken demo app. Then source a `.env` file that sets infrastructure URLs.

```bash
./demo/cluster/setup.sh gcp
source demo/.env
```

The `.env` file sets infrastructure URLs only (kubeconfig path, vector DB URLs, OTel
endpoint). The audience-facing env vars are set live on stage after each vote.

---

## Demo Flow

### Act 1: Broken App

A developer's app is broken in production. Their company runs an Internal Developer
Platform on Kubernetes, but the developer doesn't have direct cluster access — too risky.

The dev knows their app is broken but they don't know why.

Demo that kubectl commands don't work — the presenter's terminal has no kubeconfig:

```bash
kubectl get pods
# error: no cluster configured
```

> "What if we gave our developer an AI agent that could talk to the cluster on their
> behalf?"

### Vote 1: Agent Framework — LangGraph or Vercel AI SDK?

The audience chooses which agent framework to use.

### Act 2: Agent with kubectl Tools

The presenter sets the env vars based on the audience's vote:

```bash
export CLUSTER_WHISPERER_AGENT=langgraph   # (or vercel)
export CLUSTER_WHISPERER_TOOLS=kubectl
```

Then runs the agent:

```bash
cluster-whisperer "Why is my app broken?"
```

The agent streams its thinking live in the terminal — the audience watches it reason
through the problem, call kubectl, read logs, and conclude the database is missing.

The presenter follows up:

```bash
cluster-whisperer "Can you help me fix this? Which database should I deploy?"
```

The agent tries to figure out which database to deploy. It runs `kubectl get crd` and
the audience sees 1,000+ CRDs scroll by. The resource names are opaque — the right
answer is `managedservices.platform.acme.io`, but nothing in that name says "database."
The agent can't make sense of them without semantic understanding.

> "The agent can see the cluster, but it can't make sense of the platform's capabilities.
> We need to give it semantic understanding."

### Vote 2: Vector Database — Chroma or Qdrant?

The audience chooses which vector database backend to connect.

### Act 3: Agent with Semantic Search + Deploy

The presenter sets the vector backend based on the vote and adds the vector tool:

```bash
export CLUSTER_WHISPERER_VECTOR_BACKEND=qdrant   # (or chroma)
export CLUSTER_WHISPERER_TOOLS=kubectl,vector
```

```bash
cluster-whisperer "What database should I deploy for my app?"
```

The agent searches the vector database, finds the one platform-approved PostgreSQL
resource among 1,000+ CRDs, and explains it.

But the dev can't deploy — they don't have the apply tool yet. The presenter adds it:

```bash
export CLUSTER_WHISPERER_TOOLS=kubectl,vector,apply
```

Now the agent has `kubectl_apply`, but it can only deploy resources from the approved
platform catalog. The tool validates the resource type against the capabilities
collection before applying — this is enforced in code, not in the prompt.

The agent deploys the platform-approved ManagedService. The database comes up, the app
connects, and it works.

> "The agent found the right resource out of over a thousand options because it has
> semantic understanding of what each one does. And it could only deploy resources
> from the approved catalog — the platform team controls what's allowed."

But how can platform engineers understand who is using their agent, and how, and for what?

### Vote 3: Observability Backend — Jaeger or Datadog?

The audience chooses where to look at traces.

### Act 4: Observability

Everything was instrumented with OpenTelemetry the whole time. The presenter opens
whichever backend the audience chose and shows the full investigation trace:

- Every LLM reasoning step
- Every tool call (kubectl commands, vector searches)
- The deploy operation
- Token usage, latency, tool execution times

---

## What the Presenter Types on Stage

The only things typed live are `export` commands and `cluster-whisperer` questions.
Everything else is pre-deployed.

```bash
# Act 1: show that kubectl doesn't work
kubectl get pods                                        # fails — no kubeconfig

# Vote 1 result → Act 2
export CLUSTER_WHISPERER_AGENT=langgraph                # (or vercel)
export CLUSTER_WHISPERER_TOOLS=kubectl
cluster-whisperer "Why is my app broken?"
cluster-whisperer "Can you help me fix this? Which database should I deploy?"

# Vote 2 result → Act 3
export CLUSTER_WHISPERER_VECTOR_BACKEND=qdrant          # (or chroma)
export CLUSTER_WHISPERER_TOOLS=kubectl,vector
cluster-whisperer "What database should I deploy for my app?"

# Agent finds it but can't deploy — add the apply tool
export CLUSTER_WHISPERER_TOOLS=kubectl,vector,apply
# (re-run or new question to deploy)

# Vote 3 result → Act 4
# Open Jaeger or Datadog UI in the browser
```

---

## Technical Architecture

### How Votes Work

Everything is pre-deployed. Votes don't install anything — they switch which pre-deployed
component the agent connects to via env vars:

| Env Var | Options | What It Switches |
|---------|---------|------------------|
| `CLUSTER_WHISPERER_AGENT` | `langgraph`, `vercel` | Which agent framework runs |
| `CLUSTER_WHISPERER_TOOLS` | `kubectl`, `vector`, `apply` (comma-separated) | Which tools the agent has |
| `CLUSTER_WHISPERER_VECTOR_BACKEND` | `chroma`, `qdrant` | Which vector DB the agent queries |

Observability doesn't need switching — both Jaeger and Datadog receive all traces
simultaneously via the OTel Collector. The presenter just opens the chosen UI.

### Agent Implementations

Two agent implementations sharing the same tool core:

```text
src/tools/core/           <- Shared business logic (kubectl, vector search, apply)
src/tools/langchain/      <- LangGraph tool wrappers
src/tools/vercel/         <- Vercel AI SDK tool wrappers
src/agent/investigator.ts <- LangGraph agent
src/agent/vercel.ts       <- Vercel AI SDK agent
```

### Tool Groups

| Group | Tools Included |
|-------|----------------|
| `kubectl` | kubectl_get, kubectl_describe, kubectl_logs |
| `vector` | vector_search (semantic + keyword + metadata) |
| `apply` | kubectl_apply (with catalog validation) |

### kubectl_apply — Catalog Validation

The `kubectl_apply` tool enforces platform policy **in code, not in the prompt**:

1. Parse incoming YAML to extract `kind` and `apiGroup`
2. Query the capabilities collection — is this resource type in the catalog?
3. If **not found**: return error `"Resource type X is not in the approved platform catalog"`
4. If **found**: run `kubectl apply -f -`

The agent cannot bypass this — it's the tool's execution path.

### Cluster Access

The presenter's terminal has no KUBECONFIG exported — `kubectl get pods` fails.
The agent has its own kubeconfig passed internally via `CLUSTER_WHISPERER_KUBECONFIG`
(set in the `.env` file sourced before the demo). Only the agent has cluster access.

### Demo Cluster Components

| Component | Purpose |
|-----------|---------|
| GKE cluster (3x n2-standard-4) | Kubernetes environment |
| Crossplane + 35 sub-providers (~1,000 CRDs) | The "overwhelming" moment |
| Platform ManagedService XRD/Composition (`managedservices.platform.acme.io`) | The one right answer — needle in the haystack (opaque name forces vector search) |
| Demo app | Intentionally broken (CrashLoopBackOff without database) |
| Chroma | Vector DB option A |
| Qdrant | Vector DB option B |
| Jaeger | Observability option A |
| Datadog (via OTel Collector) | Observability option B |
| k8s-vectordb-sync | Populates vector DBs with cluster data |
| cluster-whisperer serve | Receives sync data from controller |
| NGINX Ingress | External access via nip.io DNS |

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
which one the agent connects to (an env var), not which one gets installed. No risky
live installs on stage.

### Only the agent has cluster access
The presenter's terminal has no kubeconfig. The cluster-whisperer CLI process has its
own kubeconfig passed via env var. The platform team controls what tools the agent
has — that's the guardrail.

### Progressive capability reveal
The demo builds capability in layers: no tools → kubectl → kubectl + vector → kubectl +
vector + apply. Each layer solves a problem the previous layer couldn't. This makes the
value of each technology choice tangible.

### Env vars over CLI flags
The presenter sets `export CLUSTER_WHISPERER_TOOLS=kubectl` once after a vote instead of
typing `--tools kubectl --agent langgraph --vector-backend qdrant` every time they run
the agent. Cleaner, less error-prone on stage.
