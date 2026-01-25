# cluster-whisperer

AI agent that answers natural language questions about your Kubernetes cluster.

## What is this?

A CLI tool that lets you ask questions about your Kubernetes cluster in plain English:

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

The agent investigates by running kubectl commands, showing its reasoning along the way. The "Thinking:" lines appear in italic in your terminal.

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

# Or if you have the key exported directly
npm start -- "Why is my-app pod crashing?"
```

### MCP Server (Claude Code, Cursor, etc.)

Add to your `.mcp.json` (in project root or `~/.claude/`):

```json
{
  "mcpServers": {
    "cluster-whisperer": {
      "command": "node",
      "args": ["/path/to/cluster-whisperer/dist/mcp-server.js"]
    }
  }
}
```

Restart your MCP client. The kubectl tools will be available alongside your other tools.

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
User Question → [Claude Code / Cursor] → MCP → [kubectl tools] → Cluster → Answer
                        ↑                         |
                        └─────────────────────────┘
                       (external LLM orchestrates)
```

The MCP server exposes the same tools to any MCP-compatible client. The client's LLM does the reasoning.

### Available Tools

Both interfaces provide these read-only kubectl tools:
- `kubectl_get` - List resources and their status
- `kubectl_describe` - Get detailed resource information
- `kubectl_logs` - Check container logs

## Project Structure

```text
src/
├── index.ts               # CLI entry point
├── mcp-server.ts          # MCP server entry point
├── agent/
│   └── investigator.ts    # ReAct agent setup
├── tools/
│   ├── core/              # Shared tool logic (schemas, execution)
│   │   ├── kubectl-get.ts
│   │   ├── kubectl-describe.ts
│   │   └── kubectl-logs.ts
│   ├── langchain/         # CLI agent wrappers
│   │   └── index.ts
│   └── mcp/               # MCP server wrappers
│       └── index.ts
└── utils/
    └── kubectl.ts         # Shared kubectl execution helper

prompts/
└── investigator.md        # System prompt (separate file for easy iteration)

docs/
├── kubectl-tools.md                # How kubectl tools work
├── agentic-loop.md                 # How the ReAct agent works
├── mcp-server.md                   # MCP server architecture
├── mcp-research.md                 # MCP research findings
├── extended-thinking-research.md   # Extended thinking implementation notes
└── langgraph-vs-langchain.md       # LangChain vs LangGraph explained
```

## License

MIT
