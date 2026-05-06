# Demo Flow — Your Platform's Next Interface Is an Agent

This documents the expected agent behavior across all four acts of the solo demo for "Your Internal Developer Platform's Next Interface Is an AI Agent."

The demo uses the `plz` CLI alias with LangGraph, Qdrant, and Datadog. Thread memory is active throughout — all four acts are one continuous conversation.

---

## Act 1: kubectl investigation

### Scenario

The demo app (`demo/app/`) is deployed to a Kubernetes cluster with `DATABASE_URL` pointing to `postgres://db-service:5432/myapp` — a service that doesn't exist. The app crashes immediately on startup, producing **CrashLoopBackOff**.

The developer has no direct kubectl access (`kubectl get pods` fails with "connection refused" — the presenter's default shell has no KUBECONFIG set, by design). The agent has cluster access via its own kubeconfig.

**Prompt:** `plz "Something's wrong with my application — can you investigate what's happening and why?"`

### Expected Agent Steps

The agent follows the ReAct pattern (Reason → Act → Observe → Repeat):

**Step 1: Broad cluster scan**
- **Tool**: `kubectl_get` — pods across all namespaces
- **Finds**: `demo-app` pod in `CrashLoopBackOff` with multiple restarts
- The agent starts broad because the user didn't specify which app. The broken pod is the only non-Running pod.

**Step 2: Describe the failing pod**
- **Tool**: `kubectl_describe` — the demo-app pod
- **Finds**: Container exits with code 1 after ~1 second; `DATABASE_URL` env var set to `postgres://db-service:5432/myapp`; restart count incrementing

**Step 3: Check application logs**
- **Tool**: `kubectl_logs` — with `--previous` flag (container keeps restarting)
- **Finds**:
  ```text
  [demo-app] Starting server...
  [demo-app] Connecting to database at postgres://db-service:5432/myapp...
  [demo-app] FATAL: Cannot connect to database at postgres://db-service:5432/myapp - getaddrinfo ENOTFOUND db-service
  [demo-app] Exiting with code 1
  ```
  The log format is intentionally agent-friendly: single-line, includes "database" and "FATAL", shows exact connection target, shows specific failure (`ENOTFOUND` = DNS resolution failed = service doesn't exist).

**Step 4: Verify the database service is missing**
- **Tool**: `kubectl_get` — services in default namespace
- **Finds**: Only `demo-app` and `kubernetes` services. No `db-service`.

**Agent diagnosis:** "Your app is broken because the database is completely missing from your cluster. The `demo-app` is configured to connect to `postgres://db-service:5432/myapp`, but no `db-service` exists."

### Follow-up: CRD wall

**Prompt:** `plz "Do you know what database I should use?"`

The agent tries to find the right database by listing CRDs. It finds 360+ Crossplane CRDs with no way to identify which one is relevant. It cannot make a recommendation. This is intentional — the CRD wall sets up the vector search reveal.

---

## Act 2: Vector search

**Setup:** `vectordb qdrant` + `tools kubectl,vector`

This continues the same thread from Act 1. The agent already knows about the CrashLoopBackOff and the missing database.

The cluster has a controller running that syncs all Kubernetes resources into a Qdrant vector database. The capabilities collection contains ~20 ManagedService resources from different teams (1 real + 19 decoys). The real one is for the Spiders and Rainbows team.

### Turn 1

**Prompt:** `plz "What database should I deploy for my app?"`

- **Tool**: `vector_search` on the capabilities collection
- **Finds**: ~20 ManagedService resources from different teams (analytics, billing, HR, etc.)
- Agent has too many results — asks follow-up questions to narrow down

### Turn 2

**Prompt:** `plz "I'm not sure about most of that. My team is called the Spiders and Rainbows team. I don't know if it's Postgres or MySQL."`

- **Tool**: `vector_search` again with "Spiders and Rainbows" context
- **Finds**: Exactly one match — `platform.acme.io/v1alpha1 ManagedService` for the Spiders and Rainbows team, managed by the platform team for the Spiders and Rainbows project
- Agent returns the resource name, apiVersion, and example YAML

### Turn 3

**Prompt:** `plz "Will you deploy it for me?"`

- Agent says it cannot — no apply tool available
- On stage: "I'd have to put in a ticket"

---

## Act 3: Apply tool + Kyverno guardrails

**Setup:** `tools kubectl,vector,apply`

This is the narrative moment where the ticket gets resolved. The platform team has granted the apply tool.

### Tron deploy attempt

**Prompt:** `plz "Go ahead and deploy a Tron game so I have something to do while I wait for my database ticket"`

- Agent attempts `kubectl apply` with a Tron/nginx manifest
- **Kyverno blocks it**: "Only platform-approved ManagedService resources from `platform.acme.io` can be deployed through the cluster whisperer agent."
- Agent reports it cannot deploy Tron

This fires because the Kyverno admission controller has a ClusterPolicy scoped to the CLI kubeconfig identity. It denies any CREATE where the resource is not `platform.acme.io/v1alpha1` + `ManagedService`. The platform team is helpful but not naive.

### Real database deploy

**Prompt:** `plz "Fine. Deploy the database you found for me."`

- Agent applies the ManagedService YAML from Turn 2
- `kubectl apply` succeeds — Kyverno allows `platform.acme.io/v1alpha1 ManagedService`
- Crossplane picks up the resource and starts provisioning PostgreSQL in-cluster
- Agent reports SYNCED and READY

**Wait ~15 seconds** while Crossplane provisions the PostgreSQL instance and creates the `db-service` Kubernetes service. The demo-app pod will restart and connect successfully once `db-service` exists.

### App comes alive

**Prompt:** `plz "Is my app running now? What's the URL?"`

- **Tool**: `kubectl_get` — pods in default namespace
- **Finds**: `demo-app` now Running (or about to be — if still in backoff, wait 30 seconds and ask again)
- **Tool**: `kubectl_get` — ingresses
- **Finds**: `http://demo-app.<base-domain>`
- Agent returns the URL

Open the URL in a browser: the spider page appears with Whitney's YouTube link.

---

## Act 4: Observability

No slides — open Datadog LLM Observability directly and talk over it.

The entire demo was instrumented with OpenTelemetry using GenAI semantic conventions throughout. Every LLM call, every tool execution, every reasoning step was traced.

**What to show in Datadog:**

- **Trace list**: Each `plz` invocation is a root span — show the full run as a list of traces
- **Trace detail**: Click into a trace to see the tool call sequence (kubectl_get → kubectl_describe → kubectl_logs), LLM calls, and reasoning steps
- **The Tron attempt**: The blocked Kyverno request is visible — platform engineers can see what developers tried to do and why it failed
- **Prompts**: Drill into an LLM span to see the exact prompt the developer sent
- **Cost and token usage**: Visible per trace — platform engineers can see what the agent costs to run
- **The value**: "As a platform engineer, I can see exactly what developers are asking of this tool, what's working, and what's failing — all the way down to the prompt."

---

## Why This Works for the Demo

1. **Clear investigation path**: Each act logically follows from the previous one
2. **Visible reasoning**: Extended thinking shows the audience *why* the agent chooses each tool
3. **Agent-friendly errors**: The `[demo-app] FATAL:` log format gives the agent clear signal in Act 1
4. **Thread memory**: All four acts are one continuous conversation — the agent remembers the CrashLoopBackOff when asked to deploy the database
5. **Natural guardrails moment**: Tron gets blocked, the real database goes through — the policy distinction is obvious without explanation
6. **Fast Acts 1-3**: ~4-5 tool calls in Act 1, 2-3 in Acts 2 and 3, completing in under a minute each
7. **Ticket through-line**: Each blocker resolves naturally ("I'd have to put in a ticket" → ticket gets resolved → agent can do the next thing)
