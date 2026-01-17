# cluster-whisperer

AI agent that answers natural language questions about your Kubernetes cluster.

## What is this?

A CLI tool that lets you ask questions about your Kubernetes cluster in plain English:

```bash
$ cluster-whisperer "Why are pods failing in the payments namespace?"

🔧 Tool: kubectl_get
   Args: {"resource":"pods","namespace":"payments"}
   Result:
   NAME                      READY   STATUS             RESTARTS
   payments-api-7d4f9-x2k    0/1     CrashLoopBackOff   5

📋 Answer:
The payments-api pod is crashing due to memory limits...
```

The agent investigates by running kubectl commands, showing its reasoning along the way.

## Status

🚧 **POC in development** - M1 and M2 complete, working on M3

See [PRD #1](./prds/1-investigation-agent-poc.md) for the full implementation plan.

## How it works: The ReAct Pattern

This agent uses the **ReAct** pattern (Reasoning + Acting):

```
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
teller run -- npm start "What's running in the default namespace?"

# Or if you have the key exported directly
npm start "Why is my-app pod crashing?"
```

## Architecture

```
User Question → ReAct Agent → [kubectl tools] → Cluster → Answer
                    ↑              |
                    └──────────────┘
                   (agent sees result,
                    decides next action)
```

The agent has access to read-only kubectl tools:
- `kubectl_get` - List resources and their status
- `kubectl_describe` - Get detailed resource information (M3)
- `kubectl_logs` - Check container logs (M4)

## Project Structure

```
src/
├── index.ts              # CLI entry point with streamEvents
├── agent/
│   └── investigator.ts   # ReAct agent setup (M2 ✅)
├── tools/
│   └── kubectl-get.ts    # kubectl_get tool (M1 ✅)
└── utils/
    └── kubectl.ts        # Shared kubectl execution helper

prompts/
└── investigator.md       # System prompt (separate file for easy iteration)

docs/
├── kubectl-tools.md      # How tools work (M1)
└── agentic-loop.md       # How the agent works (M2)
```

## License

MIT
