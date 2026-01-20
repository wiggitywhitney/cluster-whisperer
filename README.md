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
   Result: Error: Cannot find module '/app/server.js'

────────────────────────────────────────────────────────────
📋 Answer:
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
- `ANTHROPIC_API_KEY` environment variable (managed via [Teller](https://github.com/tellerops/teller))

## Setup

```bash
npm install
npm run build
```

## Usage

```bash
# Run with Teller to inject ANTHROPIC_API_KEY
# Note: teller run requires full path to node (doesn't inherit shell PATH)
teller run -- /opt/homebrew/bin/node dist/index.js "What's running in the default namespace?"

# Or if you have the key exported directly
npm start -- "Why is my-app pod crashing?"
```

## Architecture

```text
User Question → ReAct Agent → [kubectl tools] → Cluster → Answer
                    ↑              |
                    └──────────────┘
                   (agent sees result,
                    decides next action)
```

The agent has access to read-only kubectl tools:
- `kubectl_get` - List resources and their status
- `kubectl_describe` - Get detailed resource information
- `kubectl_logs` - Check container logs

## Project Structure

```text
src/
├── index.ts               # CLI entry point with streamEvents
├── agent/
│   └── investigator.ts    # ReAct agent setup
├── tools/
│   ├── kubectl-get.ts     # kubectl_get tool
│   ├── kubectl-describe.ts # kubectl_describe tool
│   └── kubectl-logs.ts    # kubectl_logs tool
└── utils/
    └── kubectl.ts         # Shared kubectl execution helper

prompts/
└── investigator.md        # System prompt (separate file for easy iteration)

docs/
├── kubectl-tools.md                # How kubectl tools work
├── agentic-loop.md                 # How the ReAct agent works
├── extended-thinking-research.md   # Extended thinking implementation notes
└── langgraph-vs-langchain.md       # LangChain vs LangGraph explained
```

## License

MIT
