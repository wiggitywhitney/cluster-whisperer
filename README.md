# cluster-whisperer

AI agent that answers natural language questions about your Kubernetes cluster.

## What is this?

An AI agent that lets you ask questions about your Kubernetes cluster in plain English. Available via **CLI** for direct terminal use or as an **MCP server** for integration with Claude Code, Cursor, and other MCP clients.

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

The agent investigates by running kubectl commands, showing its reasoning along the way.

## How it works: The ReAct Pattern

This agent uses the **ReAct** pattern (Reasoning + Acting):

```text
Think → Act → Observe → Think → Act → Observe → ... → Answer
```

1. **Reason** - Agent thinks about what to do next
2. **Act** - Agent calls a kubectl tool
3. **Observe** - Agent sees the result
4. Repeat until the agent has enough information to answer

Note: "ReAct" is an AI agent pattern from a 2022 research paper. It has nothing to do with the React.js frontend framework.

## Features

- **CLI Agent** - Ask questions directly from the terminal with visible reasoning
- **MCP Server** - Use kubectl tools from Claude Code, Cursor, or any MCP-compatible client
- **OpenTelemetry Tracing** - Full observability with traces exportable to Datadog, Jaeger, etc.
- **Extended Thinking** - See the agent's reasoning process as it investigates

## Prerequisites

- Node.js 18+
- kubectl CLI installed and configured
- `ANTHROPIC_API_KEY` environment variable (managed via [vals](https://github.com/helmfile/vals))

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

## Architecture

cluster-whisperer exposes kubectl tools via two interfaces:

### CLI Agent

```text
User Question → ReAct Agent → [kubectl tools] → Cluster → Answer
                    ↑              |
                    └──────────────┘
                   (agent sees result,
                    decides next action)
```

The CLI agent has its own reasoning loop - it decides which tools to call and interprets the results.

### MCP Server

```text
User Question → [Claude Code / Cursor] → MCP → investigate tool → ReAct Agent → Cluster
                                                      ↑                  |
                                                      └──────────────────┘
                                                     (agent reasons internally)
```

The MCP server exposes a single `investigate` tool that wraps the same ReAct agent used by the CLI. This gives MCP clients complete investigations with full tracing - one call captures the entire reasoning chain.

### Available Tools

**CLI Agent**: Uses these tools internally during investigation:
- `kubectl_get` - List resources and their status
- `kubectl_describe` - Get detailed resource information
- `kubectl_logs` - Check container logs

**MCP Server**: Exposes a single high-level tool:
- `investigate` - Ask a question, get a complete answer (wraps the ReAct agent)

## Observability

OpenTelemetry tracing provides visibility into agent operations:

```text
cluster-whisperer.investigate (root span)
├── kubectl_get.tool
│   └── kubectl get pods -n default
├── kubectl_describe.tool
│   └── kubectl describe pod broken-pod
└── kubectl_logs.tool
    └── kubectl logs broken-pod
```

**Environment Variables:**

| Variable | Default | Description |
|----------|---------|-------------|
| `OTEL_TRACING_ENABLED` | `false` | Enable tracing |
| `OTEL_EXPORTER_TYPE` | `console` | `console` or `otlp` |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | - | OTLP collector URL (e.g., `http://localhost:4318`) |
| `OTEL_CAPTURE_AI_PAYLOADS` | `false` | Capture tool inputs/outputs in traces |

See `docs/tracing-conventions.md` for the complete tracing specification.

## Project Structure

```text
src/
├── index.ts               # CLI entry point
├── mcp-server.ts          # MCP server entry point
├── agent/
│   └── investigator.ts    # ReAct agent setup (LangGraph)
├── tools/
│   ├── core/              # Shared tool logic (schemas, execution)
│   │   ├── kubectl-get.ts
│   │   ├── kubectl-describe.ts
│   │   └── kubectl-logs.ts
│   ├── langchain/         # CLI agent wrappers
│   │   └── index.ts
│   └── mcp/               # MCP server wrappers
│       └── index.ts
├── tracing/               # OpenTelemetry instrumentation
│   ├── index.ts           # Tracer initialization
│   ├── context-bridge.ts  # AsyncLocalStorage context propagation
│   └── tool-tracing.ts    # Tool span wrapper
└── utils/
    └── kubectl.ts         # Shared kubectl execution helper

prompts/
└── investigator.md        # System prompt (separate file for easy iteration)

docs/
├── kubectl-tools.md       # How kubectl tools work
├── agentic-loop.md        # How the ReAct agent works
├── mcp-server.md          # MCP server architecture
├── opentelemetry.md       # OpenTelemetry implementation guide
├── tracing-conventions.md # Complete tracing specification
└── langgraph-vs-langchain.md  # LangChain vs LangGraph explained
```

## License

MIT
