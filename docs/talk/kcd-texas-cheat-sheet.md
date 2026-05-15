# KCD Texas — Talk Notes Cheat Sheet

---

## Agent Framework — What It Provides

### Memory
- **Memory** — conversation history, context window management

### Handling Inputs/Outputs
- **Type checking**
- **schema validation**
- **sanitization**
- **File loading** and document parsing

### Tools
- **Tool use** / function calling

### Plumbing
- **Retry and error handling**
- **Rate limiting**
- **Observability** and tracing hooks
- **Threading** / concurrency management


---

## The Controller — What, When, Why

**What it syncs:**
- All Kubernetes resources that support `list` + `watch` verbs
- CRDs
- Instances


**What it skips** (high-churn, low signal for semantic search):
- `events`
- `leases`
- `endpointslices`
- `componentstatuses`


**When it syncs:**
- On resource changes (add, update, delete) via **Kubernetes watch events**
- **Full resync every 24 hours** for eventual consistency


**Why:** Keeps the agent's knowledge current — queries always reflect **live cluster state**, not a stale snapshot

---

## The Controller — How it Works

### Step 1: Discovery = Deterministically runs `kubectl explain` on each eligible resource in the cluster, collects schema and description

### Step 2: Inference = LLM receives this and comes up with:
- capability search terms
- providers
- complexity
- description
- use case
- example YAML

### Step 3: embedding = embedding model (Voyage AI) is used

### Step 4: storage = upserted into vector database

*Step 2 is the only non-deterministic step*

---

## Why Build and Maintain Vector Search

### **Natural language queries / Semantic matches**
— no exact keyword required
- Handles **synonyms, paraphrasing, partial descriptions**

### Scale
- **One vector search** instead of many tool calls
- LLM can easily **search hundreds of CRDs**
- **Pre-computed embeddings** = fast query latency

### Richer Descriptions
- `kubectl explain` returns raw **OpenAPI schema** — hundreds of lines, no meaning
- The LLM transforms this into **human-readable descriptions** with context: complexity, use case, searchable capability terms
- "Managed PostgreSQL for the Spiders and Rainbows team, low complexity" is **far more searchable** than 200 lines of spec fields

---

## Kubernetes Security Layers Still in Play

- **Identity** — RBAC, service accounts, workload identity
- **Encryption** — TLS in transit, secrets encryption at rest
- **Admission controller policies** — Kyverno, OPA/Gatekeeper *(this demo!)*
- **Network policies** — restrict pod-to-pod and egress traffic
- **Runtime policies** — seccomp, AppArmor, pod security standards
- **Image security** — signing, scanning, supply chain controls
- **AI gateway** — centralized egress for LLM calls; model allowlisting, rate limiting, prompt/response auditing, data exfiltration controls
