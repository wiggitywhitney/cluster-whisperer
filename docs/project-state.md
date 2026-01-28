# Project State: KubeCon Demo & Related Work

This document explains what Whitney is building, why, and how the pieces fit together. It's written for future AI agents who need context on this project.

---

## Two Deliverables

### 1. KubeCon Demo (Spring 2026)

An interactive session where the audience votes at key moments to guide an app's journey from idea to deployment with AI help. The audience chooses which AI tooling to use at each step.

**Repo**: TBD - might be cluster-whisperer, might be a new repo

**Abstract summary**: A hero app lives in a Kubernetes cluster supported by an Internal Developer Platform. Developers want more: can AI make their experience smoother? The audience votes on AI tooling choices at three decision points.

### 2. You Choose Streaming Show

A broader streaming show format with 6+ episodes covering AI tooling decisions. Structured like the Choose Your AI Adventure repo format.

**Repo**: Separate from KubeCon demo, follows Choose Your AI Adventure structure

**Status**: Ignore for now. Build toward it, but focus on KubeCon first.

---

## KubeCon Demo: 3 Scenarios, 6 Technologies, 8 Combinations

### The Three Scenarios

| Scenario | Problem | What Happens | Resolution |
|----------|---------|--------------|------------|
| 1 | App updated, now broken | App is looking for a database it can't find | Agent troubleshoots the issue |
| 2 | Too many provider CRDs | Developer doesn't know how to navigate | Agent queries vector DB for guidance |
| 3 | What is my agent doing? | Need visibility into agent behavior | View OTel traces in observability backend |

### The Three Decision Points (Audience Votes)

| Decision | Option A | Option B |
|----------|----------|----------|
| Agent Framework | Vercel | LangChain |
| Vector Database | Quadrant | Chroma |
| Observability Backend | Jaeger | Datadog |

### All 8 Combinations Must Work

The demo environment must support any combination:
- Vercel + Quadrant + Jaeger
- Vercel + Quadrant + Datadog
- Vercel + Chroma + Jaeger
- Vercel + Chroma + Datadog
- LangChain + Quadrant + Jaeger
- LangChain + Quadrant + Datadog
- LangChain + Chroma + Jaeger
- LangChain + Chroma + Datadog

### Who Builds What

**Whitney builds all 6 technologies.** Viktor has implementations of Vercel + Quadrant + Jaeger that serve as backup if time runs short, but the goal is for Whitney to build everything.

---

## Repository Locations

All repositories are in `~/Documents/Repositories/`:

| Repo | Path | Purpose |
|------|------|---------|
| cluster-whisperer | `~/Documents/Repositories/cluster-whisperer` | LangChain agent code |
| spider-rainbows | `~/Documents/Repositories/spider-rainbows` | Kind cluster with demo scenarios |
| commit_story | `~/Documents/Repositories/commit_story` | Reference for secret paths |
| choose-your-ai-adventure | TBD | Streaming show framework |

---

## Current Repositories

### cluster-whisperer (this repo)

**Purpose**: AI agent that answers natural language questions about Kubernetes clusters

**Technology**: LangChain with kubectl tools, MCP server interface

**Status**: PRDs 1-8 define the work
- PRD #1-5: Complete (basic agent, CLI, MCP server)
- PRD #6: In progress - OpenTelemetry instrumentation (M1-M4 complete, M5 next)
- PRD #7: Planned - Vector database (Chroma)
- PRD #8: Planned - Datadog observability

**Role in KubeCon demo**: This is the LangChain agent implementation. May become the KubeCon demo repo, or may be pulled into a separate demo repo.

### Spider Rainbows

**Location**: `~/Documents/Repositories/spider-rainbows`

**Purpose**: Test cluster with setup/teardown scripts and breakable scenarios

**Current state**: Has a kind cluster running with V3 scenario (taint/toleration mismatch)

**Scripts**:
| Script | Purpose |
|--------|---------|
| `./setup-platform.sh` | Create kind cluster and deploy platform |
| `./destroy.sh` | Tear down cluster |
| `./reset-to-v1-and-deploy.sh` | Reset to working V1 state |
| `./reset-to-v1-local.sh` | Reset to V1 locally |
| `./reset-to-v2-local.sh` | Update to V2 (breaks app at coding level) |
| `./develop-next-version.sh` | Develop next version |

**Problem for KubeCon**: The breakable scenarios (V2, V3) are wrong for the KubeCon demo. KubeCon needs "app looking for a database" not "coding-level breaks" or "taint/toleration mismatch."

**Current use**: Using this cluster for M5 testing by adding Datadog Agent to it.

### Choose Your AI Adventure

**Purpose**: Template structure for the streaming show

**Tentative episodes**:
- Episode 0: Coding tool and demo environment (no vote)
- Episode 1: Building agents (K Agent, LangChain, Vercel)
- Episode 2: Orchestrating agents
- Episode 3: Embeddings
- Episode 4: Vector database
- Episode 5: Agent observability
- Episode 6: LLM experiments, evals

**Status**: Ignore for now, build toward later

### commit-story

**Location**: `~/Documents/Repositories/commit_story`

**Relevance**: Reference for secret paths in Google Secrets Manager. Uses teller (not vals) for secrets injection.

**Secret paths** (from `.teller.yml`):
- `datadog-commit-story-dev` → DD_API_KEY
- `datadog-commit-story-app` → DD_APP_KEY
- GCP project: `demoo-ooclock`

---

## Demo Environment Requirements

### Must Have

- Kind cluster
- Demo app that breaks because it can't find a database
- Datadog Agent (with OTLP receiver enabled)
- Jaeger
- Chroma
- Quadrant
- Setup that allows any combination of the above

### Open Questions

**Platform engineering technologies**: The abstract mentions "an Internal Developer Platform built with Crossplane, ArgoCD, Kyverno, Tekton, Buildpacks, OpenTelemetry, and Backstage." Should the demo environment include some of these to tell the full IDP story?

- Argo CD for GitOps deployments?
- Crossplane for infrastructure?
- Others?

This needs discussion. The demo might be more compelling with real platform engineering infrastructure, but it also adds complexity.

**Where does the demo environment live?**
- Option A: Extend Spider Rainbows with new scenarios and observability backends
- Option B: New repo specifically for KubeCon demo
- Option C: Part of cluster-whisperer

---

## Secrets Management

### This Repo (cluster-whisperer)

Uses **vals** to inject secrets from Google Secrets Manager.

```bash
# Run with secrets injected
vals exec -i -f .vals.yaml -- node dist/index.js "your question"
```

The `-i` flag is required to inherit PATH so kubectl can be found.

### Google Secrets Manager (project: demoo-ooclock)

All secrets are in the `demoo-ooclock` GCP project.

| Secret Name | Environment Variable | Purpose |
|-------------|---------------------|---------|
| `anthropic-api-key` | `ANTHROPIC_API_KEY` | LLM API access |
| `github-token` | `GITHUB_TOKEN` | GitHub API access |
| `datadog-commit-story-dev` | `DD_API_KEY` | Datadog API key |
| `datadog-commit-story-app` | `DD_APP_KEY` | Datadog App key |

### vals Configuration

Current `.vals.yaml`:
```yaml
ANTHROPIC_API_KEY: ref+gcpsecrets://demoo-ooclock/anthropic-api-key
GITHUB_TOKEN: ref+gcpsecrets://demoo-ooclock/github-token
```

For M5, add:
```yaml
DD_API_KEY: ref+gcpsecrets://demoo-ooclock/datadog-commit-story-dev
DD_APP_KEY: ref+gcpsecrets://demoo-ooclock/datadog-commit-story-app
```

### Datadog Site

Whitney uses **US1** site: `datadoghq.com`

---

## Current Work: PRD #6 M5 (OTLP Export)

### What's Done (M1-M4)

- OTel SDK installed and configured
- Console exporter working
- MCP tool spans instrumented
- kubectl subprocess spans instrumented (as children of MCP spans)
- Dual attribute strategy (Viktor's + semconv)

### What's Done (M5)

1. ✅ OTLP exporter added to `src/tracing/index.ts`
2. ✅ Environment variable `OTEL_EXPORTER_TYPE` (console | otlp)
3. ✅ Environment variable `OTEL_EXPORTER_OTLP_ENDPOINT` for collector URL
4. ✅ Datadog Agent installed in Spider Rainbows cluster with OTLP receiver (port 4318)
5. ✅ Traces verified in Datadog APM

### Current Deployment Issue

**Problem**: cluster-whisperer runs locally but Datadog Agent is in the cluster. Requires port-forwarding (`kubectl port-forward svc/datadog 4318:4318`) which is not ideal.

**Better approaches for KubeCon demo**:
- Run cluster-whisperer in the cluster (same network as Datadog Agent)
- Run Datadog Agent locally (same machine as cluster-whisperer)
- Use Datadog's direct OTLP endpoint (only GA for LLM Observability, not general APM)

### Span Hierarchy (Fixed)

MCP tool spans and kubectl spans now correctly appear as parent-child in the same trace. Fixed by using `context.with()` in `tool-tracing.ts` for proper async context propagation.

---

## Viktor's Reference Implementations

Viktor has working implementations that can serve as reference or backup:

- **Agent**: Vercel-based (vs Whitney's LangChain)
- **Vector DB**: Quadrant (vs Whitney's Chroma)
- **Observability**: Jaeger (vs Whitney's Datadog)
- **Guide**: https://devopstoolkit.ai/docs/mcp/guides/observability-guide

His dot-ai repo has the OTel implementation patterns that informed our research in M1.

---

## Summary: What Whitney Is Doing

1. **Building cluster-whisperer** - A LangChain-based agent with kubectl tools, MCP interface, OTel instrumentation, and vector DB integration

2. **Preparing for KubeCon** - A demo where audience chooses between AI tooling options at each step (all 8 combinations work)

3. **Building toward You Choose** - A streaming show with broader coverage of AI tooling decisions

4. **Currently on PRD #6 M5** - Adding OTLP export to send traces to Datadog

The cluster-whisperer PRDs (1-8) build the LangChain + Chroma + Datadog stack. The demo environment work (TBD where it lives) will make all combinations possible.
