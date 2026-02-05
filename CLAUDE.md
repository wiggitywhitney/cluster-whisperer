# Project Guidelines

## Terminology Corrections

**Correct the user if they confuse LangChain and LangGraph** - even if you understand from context. This is for a KubeCon presentation; precise terminology matters.

- **LangGraph**: What we use for the agentic loop (cycles, state, tool-calling decisions)
- **LangChain**: The broader framework that LangGraph builds on (LLM abstractions, integrations)

If the user says "LangChain" when describing agentic/looping behavior, gently correct: "Just a note - that's LangGraph, not LangChain. LangGraph handles the agentic loop; LangChain is the underlying framework."

---

This is a learning-focused repository for a KubeCon presentation. All code and documentation should:

- Include doc strings explaining what the code does and why
- Use plain language that someone with no prior knowledge can understand
- Be succinct - explain concepts clearly without unnecessary verbosity
- Prioritize teaching over production optimization

## Project Context

**Purpose**: AI agent that answers natural language questions about Kubernetes clusters
**Audience**: Platform engineers learning to build developer tools
**Presentation**: KubeCon Spring 2026

## Architecture

This project uses **LangGraph** (built on LangChain) to create an agentic loop with multiple kubectl tools:

```
User Question → Agentic Loop → [kubectl tools] → Cluster → Answer
```

Key principles:
- **Separate tools for permissions**: Each kubectl operation (get, describe, logs) is a separate tool
- **Visible reasoning**: The agent outputs its thinking so users can see the decision process
- **Read-only first**: POC focuses on investigation tools, not mutations

## Reference Examples

Viktor's examples for patterns to follow:
- kubectl tools: https://github.com/vfarcic/dot-ai/blob/main/src/core/kubectl-tools.ts
- Agent with tools: https://github.com/vfarcic/dot-ai/blob/main/src/tools/query.ts

## Secrets Management with vals

This project uses [vals](https://github.com/helmfile/vals) to inject secrets from Google Secrets Manager.

### Running cluster-whisperer

```bash
# -i inherits environment variables (including PATH for kubectl)
vals exec -i -f .vals.yaml -- node dist/index.js "your question"
```

### Starting Claude Code

```bash
claude
```

## Datadog Remote MCP

This project uses the official Datadog remote MCP for querying traces, logs, and metrics from within Claude Code.

### Setup (one-time)

```bash
claude mcp add --transport http datadog-mcp https://mcp.datadoghq.com/api/unstable/mcp-server/mcp
```

### Authentication

On first use, Claude Code will prompt for OAuth authentication - complete the sign-in flow in your browser. Check `/mcp` to see connection status.

### Available tools

- `search_datadog_spans` - Query APM traces (e.g., `service:cluster-whisperer`)
- `get_datadog_trace` - Fetch complete trace by trace ID
- `search_datadog_logs` - Query logs
- `search_datadog_metrics` - Query metrics

### Example: Verify cluster-whisperer traces

After running the agent with OTLP export enabled, use:
```text
search_datadog_spans with query: "service:cluster-whisperer" from: "now-1h"
```

### Verify secrets are configured

```bash
vals eval -f .vals.yaml
```

## Git Workflow

- Create PRs to merge to main
- Don't squash git commits
- Make a new branch for each feature/PRD
- Ensure CodeRabbit review is examined before merging

## Testing Tracing

### MCP Mode (Claude Code)

MCP tracing is **enabled by default** in `.mcp.json`. When Claude Code calls cluster-whisperer tools, traces are exported to the local Datadog Agent.

To disable MCP tracing (reduces noise during development):
```json
// In .mcp.json, set env to empty:
"env": {}
```

To re-enable, restore the environment variables:
```json
"env": {
  "OTEL_TRACING_ENABLED": "true",
  "OTEL_EXPORTER_TYPE": "otlp",
  "OTEL_EXPORTER_OTLP_ENDPOINT": "http://localhost:4318",
  "OTEL_TRACE_CONTENT_ENABLED": "true"
}
```

**Note**: `OTEL_TRACE_CONTENT_ENABLED` captures tool inputs/outputs in traces. Disable this (`"false"` or remove) if tracing sensitive data.

After changing `.mcp.json`, restart Claude Code to pick up the new configuration.

### CLI Mode

For complex tracing scenarios that trigger multiple LLM calls and tool invocations, use the "broken pod" investigation:

```bash
# Console output (development)
OTEL_TRACING_ENABLED=true \
vals exec -i -f .vals.yaml -- node dist/index.js "Find the broken pod and tell me why it's failing"

# OTLP export to Datadog (via local agent)
OTEL_TRACING_ENABLED=true \
OTEL_EXPORTER_TYPE=otlp \
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 \
vals exec -i -f .vals.yaml -- node dist/index.js "Find the broken pod and tell me why it's failing"
```

This triggers a full investigation: LLM reasoning → kubectl_get (find pods) → kubectl_describe (check events) → kubectl_logs (read output) → multiple iterations until root cause found.

The local Datadog Agent receives traces on `localhost:4318` and forwards them to Datadog. No port-forwarding required.

View traces in Datadog: <https://app.datadoghq.com/apm/traces?query=service%3Acluster-whisperer>

## OpenTelemetry Weaver Schema Validation

This project uses [OpenTelemetry Weaver](https://github.com/open-telemetry/weaver) to define and validate span attributes. The schema in `telemetry/registry/` is the source of truth for tracing conventions.

### Installation

Weaver requires Rust. Install with:

```bash
cargo install weaver
```

### Validation Commands

```bash
# Validate registry structure and attribute definitions
npm run telemetry:check

# Resolve OTel references and generate resolved.json
npm run telemetry:resolve
```

### Registry Structure

```
telemetry/registry/
├── registry_manifest.yaml    # Schema name, version, OTel dependency
├── attributes.yaml           # Attribute groups with refs + custom definitions
└── resolved.json             # Generated output with expanded OTel references
```

See `docs/weaver-research.md` for the complete attribute inventory and rationale.
