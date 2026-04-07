# Choose Your Own Adventure: KubeCon Demo Flow

This is a KubeCon talk called "Choose Your Own Adventure." The core idea: the audience
votes on technology choices during a live demo, and those votes change what's running on
stage. The message is that the pattern — using an AI agent as a developer's interface to
a Kubernetes platform — works regardless of which specific technologies you pick.

---

## Setup (before the demo starts)

Run one setup script that creates a GKE cluster with everything pre-deployed — both
agents, both vector databases, both observability backends, ~360 Crossplane CRDs, and
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
agent langgraph   # (or vercel)
tools kubectl
```

Then runs the agent:

```bash
plz "Something's wrong with my application — can you investigate what's happening and why?"
```

The agent streams its thinking live in the terminal — the audience watches it reason
through the problem using all three kubectl tools (get, describe, logs), and concludes
the database is missing.

The presenter follows up:

```bash
plz "Do you know what database I should use?"
```

The agent enters resource discovery mode. Without vector search, it falls back to
`kubectl get crd` and the audience sees hundreds of CRDs scroll by. The resource names
are opaque — the right answer is `managedservices.platform.acme.io`, but nothing in
that name says "database." The agent lists cloud provider CRDs (RDS, Cloud SQL, etc.)
but misses the 20 platform ManagedService CRDs entirely. It can't make sense of them
without semantic understanding.

> "The agent can see the cluster, but it can't make sense of the platform's capabilities.
> We need to give it semantic understanding."

### Vote 2: Vector Database — Chroma or Qdrant?

The audience chooses which vector database backend to connect.

### Act 3a: Agent with Semantic Search (no deploy)

The presenter sets the vector backend based on the vote and adds the vector tool:

```bash
vectordb qdrant   # (or chroma)
tools kubectl,vector
```

Thread memory is automatically enabled when vector tools are active — the agent defaults
to thread ID `demo` so it remembers what was said across invocations. No manual setup needed.

**Turn 1** — the presenter asks a broad question:

```bash
plz "What database should I deploy for my app?"
```

The agent searches the vector database and finds multiple ManagedService resources from
different teams (Payments, Data, Marketing, Inventory, etc.) — all with similar names
and capabilities. There are 20 of them. The agent **does not guess**. It asks the
presenter follow-up questions: what team are you on? What type of app?

**Turn 2** — the presenter gives a vague answer:

```bash
plz "I'm not sure about most of that. My team is called the You Choose team. I don't know if it's Postgres or MySQL."
```

The agent searches again using "You Choose" as context. This time it finds
`managedservices.platform.acme.io` — the one resource whose description mentions
"You Choose project" and "Whitney and Viktor." The agent recommends it with example
YAML and asks: "Would you like me to deploy this?"

**Turn 3** — the presenter says yes:

```bash
plz "Yes please, will you deploy it for me?"
```

The agent recognizes it **cannot deploy** — it doesn't have the apply tool. It provides
the YAML and suggests `kubectl apply` manually.

> "The agent found the needle in the haystack — one resource out of twenty with the
> same name, because it has semantic understanding of what each one does. But it can't
> act on it. Let's give it the ability to deploy — but with cluster-level guardrails."

### Act 3b: Agent Deploys

The presenter adds the apply tool (same thread — the agent remembers which database to deploy):

```bash
export CLUSTER_WHISPERER_TOOLS=kubectl,vector,apply
plz "Go ahead and deploy it"
```

Now the agent has `kubectl_apply`. The tool is intentionally simple — it parses the
YAML and runs `kubectl apply`. Enforcement lives in the cluster: a Kyverno ClusterPolicy
at `k8s/kyverno-allowlist.yaml` restricts the `cluster-whisperer-mcp` ServiceAccount to
`platform.acme.io/v1alpha1` ManagedService resources only. The policy lives in the
repository as YAML — auditable, reviewable, and independent of application code.

The agent deploys the platform-approved ManagedService. Crossplane provisions the
PostgreSQL database and the `db-service` endpoint (~15 seconds). The presenter talks
through what just happened while the database comes up, then asks:

```bash
plz "Is my app running now? What's the URL to access it?"
```

The agent checks pods and ingresses, finds the demo app is now Running, and returns
`http://demo-app.<base-domain>`. The presenter opens the URL — the spider page appears
with clickable zones linking to Whitney's and Viktor's YouTube channels.

The demo app URL is also in `demo/.env` as `DEMO_APP_URL`. While the app was crashing,
this URL returned 502. Now it serves the spider page — the payoff moment.

> "The agent found the right resource, and the platform team controls what it can deploy —
> not in application code, but in a Kyverno policy that lives in the cluster as YAML."

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
agent langgraph                                         # (or vercel)
tools kubectl
plz "Something's wrong with my application — can you investigate what's happening and why?"
plz "Do you know what database I should use?"

# Vote 2 result → Act 3a (vector search, multi-turn conversation)
vectordb qdrant                                         # (or chroma)
tools kubectl,vector
plz "What database should I deploy for my app?"
# Agent finds 20 similar ManagedService resources, asks follow-up questions
plz "I'm not sure. My team is the You Choose team. I don't know if it's Postgres or MySQL."
# Agent narrows to platform.acme.io, recommends it, offers YAML
plz "Yes please, will you deploy it for me?"
# Agent says it can't — no apply tool

# Act 3b: add the apply tool → agent remembers which database, now it can deploy
tools kubectl,vector,apply
plz "Go ahead and deploy it"
# talk through what happened while Crossplane provisions (~15s)
plz "Is my app running now? What's the URL to access it?"
# Agent checks pods + ingress, returns the demo-app URL → open in browser

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
src/tools/core/                  <- Shared business logic (kubectl, vector search, apply)
src/tools/langchain/             <- LangGraph tool wrappers
src/tools/vercel/                <- Vercel AI SDK tool wrappers
src/agent/investigator.ts        <- LangGraph ReAct agent (also used by MCP server)
src/agent/langgraph-adapter.ts   <- Adapts LangGraph to shared AgentEvent interface
src/agent/vercel-agent.ts        <- Vercel AI SDK agent (implements AgentEvent natively)
src/agent/agent-factory.ts       <- Selects agent based on --agent flag
src/agent/agent-events.ts        <- Shared AgentEvent union type (thinking, tool_start, tool_result, final_answer)
```

### Tool Groups

| Group | Tools Included |
|-------|----------------|
| `kubectl` | kubectl_get, kubectl_describe, kubectl_logs |
| `vector` | vector_search (semantic + keyword + metadata) |
| `apply` | kubectl_apply (cluster enforces via Kyverno + RBAC) |

### kubectl_apply — Cluster-Level Enforcement

The `kubectl_apply` tool is intentionally simple:

1. Parse YAML manifest — validate `apiVersion`, `kind`, and `metadata.name`
2. Run `kubectl apply --filename -` (manifest via stdin)
3. Return the result, including any admission webhook errors

Enforcement is handled at the cluster level by two complementary layers:

**RBAC**: The `cluster-whisperer-mcp` ClusterRole grants CREATE permission only for
`platform.acme.io/managedservices`. Standard resources (Deployment, ConfigMap, Service)
are read-only for this ServiceAccount.

**Kyverno**: A ClusterPolicy (`k8s/kyverno-allowlist.yaml`) provides admission-level
enforcement. Scoped to the `cluster-whisperer-mcp` ServiceAccount, it requires
`apiVersion: platform.acme.io/v1alpha1` and `kind: ManagedService`. When the MCP
server runs in-cluster as this SA and attempts to create a non-approved resource, the
cluster returns:

```text
Error from server: admission webhook "validate.kyverno.svc" denied the request:
[require-approved-resources] Only ManagedService resources from platform.acme.io are allowed through the cluster whisperer agent.
```

The ClusterPolicy is visible in the cluster (`kubectl get clusterpolicy
cluster-whisperer-resource-allowlist --output yaml`), checked into the repo, and
enforces policy regardless of how requests arrive — MCP server, raw kubectl, or CI pipeline.

*Note: In CLI demo mode, requests use the presenter's kubeconfig and don't carry the
`cluster-whisperer-mcp` SA identity, so Kyverno doesn't fire. The live Kyverno rejection
demo requires the in-cluster MCP deployment (PRD #122).*

### Cluster Access

The presenter's terminal has no KUBECONFIG exported — `kubectl get pods` fails.
The agent has its own kubeconfig passed internally via `CLUSTER_WHISPERER_KUBECONFIG`
(set in the `.env` file sourced before the demo). Only the agent has cluster access.

### Demo Cluster Components

| Component | Purpose |
|-----------|---------|
| GKE cluster (3x n2-standard-4) | Kubernetes environment |
| Crossplane + 16 sub-providers (~360 CRDs) | The "overwhelming" moment |
| Platform ManagedService XRD/Composition (`managedservices.platform.acme.io`) | The one right answer — needle in the haystack (opaque name forces vector search) |
| Demo app | Intentionally broken (CrashLoopBackOff without database) |
| Chroma | Vector DB option A |
| Qdrant | Vector DB option B |
| Jaeger | Observability option A |
| Datadog (via OTel Collector) | Observability option B |
| k8s-vectordb-sync | Populates vector DBs with cluster data |
| cluster-whisperer serve | Receives sync data from controller |
| Kyverno | Admission controller enforcing ManagedService-only policy |
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
