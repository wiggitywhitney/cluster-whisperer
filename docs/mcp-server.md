# MCP Server

This document explains the MCP server interface for cluster-whisperer.

---

## What is MCP?

MCP (Model Context Protocol) is an open standard for connecting AI assistants to external tools. Think of it like USB for AI - a common interface that lets any AI assistant use any tool, regardless of who made them.

Before MCP, every AI tool integration was custom. Claude Code had its own way of calling tools, Cursor had another, and so on. MCP standardizes this: build an MCP server once, and any MCP client can use it.

---

## CLI Agent vs MCP Server

cluster-whisperer has two interfaces that expose the same kubectl tools:

### CLI Agent (`npm start`)

```
User Question → [Our Agent] → kubectl tools → Answer
                    ↑
              Reasoning happens here
```

The CLI agent has its own brain. You ask "why is my pod crashing?", and the agent:
1. Decides to run `kubectl_get` to find the pod
2. Sees it's in CrashLoopBackOff
3. Decides to run `kubectl_describe` to check events
4. Decides to run `kubectl_logs --previous` to see the crash
5. Synthesizes everything into an answer

The reasoning is built into the agent.

### MCP Server (`npm run mcp`)

```
User Question → [Claude Code's Brain] → MCP → kubectl tools → Answer
                        ↑
                  Reasoning happens here
```

The MCP server has no brain - it just exposes tools. When you use cluster-whisperer via Claude Code:
1. Claude Code's Claude sees the kubectl tools available
2. Claude decides which tools to call and when
3. Our MCP server executes the tools and returns results
4. Claude interprets results and decides next steps

Same tools, different orchestrator.

---

## Why Both?

**CLI is standalone**: Run it anywhere with an Anthropic API key. No IDE needed.

**MCP integrates into workflows**: Claude Code, Cursor, and other MCP clients can use the tools alongside everything else they do - file editing, git, web search, etc. The kubectl tools become part of a larger toolkit.

---

## Tools Exposed

The MCP server exposes three tools:

| Tool | Purpose |
|------|---------|
| `kubectl_get` | List resources in table format. Find what exists. |
| `kubectl_describe` | Get detailed info about one resource. See events. |
| `kubectl_logs` | Get container logs. See application errors. |

These are the same tools the CLI agent uses, just exposed over MCP.

---

## How to Use

### Configure Claude Code

Add this to your `.mcp.json` (in project root or `~/.claude/`):

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

Replace `/path/to/cluster-whisperer` with the actual path.

### Verify It Works

In Claude Code, the kubectl tools should appear in the available tools. Try asking "what pods are running in the default namespace?" and Claude should use `kubectl_get` to answer.

---

## Architecture

```
src/
├── tools/
│   ├── core/           # Shared logic (schemas, execution)
│   │   ├── kubectl-get.ts
│   │   ├── kubectl-describe.ts
│   │   └── kubectl-logs.ts
│   ├── langchain/      # CLI agent wrappers
│   │   └── index.ts
│   └── mcp/            # MCP server wrappers
│       └── index.ts
├── index.ts            # CLI entry point
└── mcp-server.ts       # MCP server entry point
```

The core logic is shared. Each interface (LangChain for CLI, MCP SDK for server) has thin wrappers that adapt the core to its framework.

---

## Transport: stdio

The MCP server uses stdio transport. This means:

1. The MCP client (Claude Code) spawns our server as a subprocess
2. Communication happens via stdin/stdout using JSON-RPC
3. The server runs locally on your machine

This is the standard pattern for local MCP servers. No network setup needed.

---

## Error Handling

Two types of errors:

**Protocol errors**: Unknown tool name, invalid arguments. The MCP SDK handles these automatically with JSON-RPC error responses.

**Execution errors**: kubectl fails, permission denied, resource not found. The tool returns the error message as text content. The client's LLM can then understand what went wrong and potentially try a different approach.
