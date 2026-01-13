# cluster-whisperer

AI agent that answers natural language questions about your Kubernetes cluster.

## What is this?

A CLI tool that lets you ask questions about your Kubernetes cluster in plain English:

```bash
$ cluster-whisperer "Why are pods failing in the payments namespace?"

📋 Answer: The payments-api pod is crashing due to memory limits...
```

The agent investigates by running kubectl commands, showing its reasoning along the way.

## Status

🚧 **POC in development** - Not yet functional

See [PRD #1](./prds/1-investigation-agent-poc.md) for the implementation plan.

## Prerequisites

- Node.js 18+
- kubectl CLI installed and configured
- `ANTHROPIC_API_KEY` environment variable

## Setup

```bash
npm install
npm run build
```

## Usage

```bash
# Ask a question about your cluster
cluster-whisperer "What's running in the default namespace?"

# Investigate an issue
cluster-whisperer "Why is my-app pod crashing?"
```

## Architecture

```
User Question → Agentic Loop → [kubectl tools] → Cluster → Answer
```

The agent has access to read-only kubectl tools:
- `kubectl_get` - List resources
- `kubectl_describe` - Get resource details
- `kubectl_logs` - Check container logs

## License

MIT
