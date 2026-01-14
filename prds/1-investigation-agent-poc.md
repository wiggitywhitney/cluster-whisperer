# PRD #1: Kubernetes Investigation Agent (POC)

**Status**: In Progress
**Created**: 2026-01-13
**GitHub Issue**: [#1](https://github.com/wiggitywhitney/cluster-whisperer/issues/1)
**Deadline**: 1 week (KubeCon demo prep)

---

## Problem Statement

Platform engineers need to build tools that help developers understand what's happening in their Kubernetes clusters. Currently, developers either need to learn kubectl or rely on platform engineers to investigate issues for them.

This POC demonstrates how to build an AI agent that answers natural language questions about a cluster, showing platform engineers the pattern they can adapt for their own organizations.

## Solution

Build a CLI tool that:
1. Accepts natural language questions about a Kubernetes cluster
2. Uses an agentic loop to decide which kubectl commands to run
3. Shows its reasoning process (for learning/debugging)
4. Returns a helpful answer

### Example Interaction

```bash
$ cluster-whisperer "Why are pods failing in the payments namespace?"

🤔 Thinking: I'll start by listing pods in the payments namespace...

🔧 Tool: kubectl_get
   Command: kubectl get pods -n payments
   Result:
   NAME                      READY   STATUS             RESTARTS
   payments-api-7d4f9-x2k    0/1     CrashLoopBackOff   5

🤔 Thinking: payments-api is crash looping. Let me get details...

🔧 Tool: kubectl_describe
   Command: kubectl describe pod payments-api-7d4f9-x2k -n payments
   Result:
   Last State: Terminated - OOMKilled

🤔 Thinking: Out of memory. Let me check logs for context...

🔧 Tool: kubectl_logs
   Command: kubectl logs payments-api-7d4f9-x2k -n payments --previous
   Result:
   [ERROR] Failed to allocate memory for request cache

📋 Answer: The payments-api pod is crashing due to memory limits.
   The container is being OOMKilled. Consider increasing memory
   limits or optimizing the application's memory usage.
```

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                         CLI                             │
│                    (commander.js)                       │
└─────────────────────┬───────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────┐
│                   AGENTIC LOOP                          │
│                   (LangChain)                           │
│                                                         │
│  ┌─────────────────────────────────────────────────┐   │
│  │ System prompt: You are a Kubernetes expert...   │   │
│  │ Available tools: kubectl_get, describe, logs    │   │
│  │ Instructions: Investigate, explain findings     │   │
│  └─────────────────────────────────────────────────┘   │
│                                                         │
│  Loop: LLM decides → calls tool → gets result →        │
│        decides next action → ... → final answer        │
└─────────────────────┬───────────────────────────────────┘
                      │
        ┌─────────────┼─────────────┐
        ▼             ▼             ▼
┌─────────────┐ ┌───────────┐ ┌───────────┐
│ kubectl_get │ │ kubectl_  │ │ kubectl_  │
│             │ │ describe  │ │   logs    │
└──────┬──────┘ └─────┬─────┘ └─────┬─────┘
       │              │             │
       └──────────────┴─────────────┘
                      │
                      ▼
              ┌───────────────┐
              │  kubectl CLI  │
              │  (subprocess) │
              └───────┬───────┘
                      │
                      ▼
              ┌───────────────┐
              │   Kubernetes  │
              │    Cluster    │
              └───────────────┘
```

## Tools (Separate for Permission Control)

Each tool is isolated so permissions can be controlled:

| Tool | kubectl command | Risk Level | POC Scope |
|------|----------------|------------|-----------|
| `kubectl_get` | `kubectl get <resource>` | Read-only | ✅ Yes |
| `kubectl_describe` | `kubectl describe <resource>` | Read-only | ✅ Yes |
| `kubectl_logs` | `kubectl logs <pod>` | Read-only | ✅ Yes |
| `kubectl_apply` | `kubectl apply -f` | **Write** | ❌ Future |
| `kubectl_delete` | `kubectl delete` | **Destructive** | ❌ Future |

### Why Separate Tools?

Keeping tools separate allows:
- Fine-grained permission control (give developers read-only access)
- Audit logging of which operations were performed
- Approval workflows for dangerous operations (future)

## Success Criteria

- [ ] CLI accepts natural language question as argument
- [ ] Agent uses agentic loop to investigate (not hardcoded flow)
- [ ] Agent outputs reasoning at each step (visible thinking)
- [ ] At least 3 kubectl tools available (get, describe, logs)
- [ ] Works against any kubeconfig-accessible cluster
- [ ] Demo-ready for KubeCon presentation

## Milestones

- [x] **M1**: Project setup + kubectl_get tool working standalone
  - package.json, tsconfig, basic structure
  - kubectl_get tool that executes and returns output
  - Manual test: tool works when called directly (see Testing section)

- [ ] **M2**: Agentic loop with visible reasoning
  - LangChain agent setup with tool binding
  - System prompt for Kubernetes investigation
  - Visible "thinking" output at each step
  - Manual test: agent can answer simple question using kubectl_get (see Testing section)

- [ ] **M3**: Add kubectl_describe tool
  - Tool implementation following same pattern
  - Agent can now get details about specific resources
  - Manual test: agent uses describe when appropriate (see Testing section)

- [ ] **M4**: Add kubectl_logs tool
  - Tool implementation with --previous flag support
  - Agent can now check container logs
  - Manual test: agent investigates crash loops using logs (see Testing section)

- [ ] **M5**: Demo prep and polish
  - Test against real cluster (see Testing section)
  - Error handling for common failures
  - README with setup instructions
  - Practice demo script

## Technical Approach

### Dependencies

```json
{
  "@langchain/anthropic": "^0.3.14",
  "@langchain/core": "^0.3.27",
  "@langchain/langgraph": "^0.2.42",
  "commander": "^13.0.0",
  "zod": "3.25.67"
}
```

**Note**: Zod must be pinned to 3.25.67 due to a [known TypeScript bug](https://github.com/langchain-ai/langchainjs/issues/8468) with the `tool()` function in newer Zod versions.

### Tool Definition Pattern

Following the pattern from reference examples:

```typescript
const kubectlGetTool = {
  name: "kubectl_get",
  description: "List Kubernetes resources. Use this to see what resources exist and their current status.",
  inputSchema: z.object({
    resource: z.string().describe("Resource type (e.g., pods, deployments, services)"),
    namespace: z.string().optional().describe("Namespace to query (omit for all namespaces)"),
    name: z.string().optional().describe("Specific resource name (omit to list all)"),
  }),
  execute: async (params) => {
    // Build and execute kubectl command
    // Return stdout
  }
};
```

### Agentic Loop Pattern

Following the pattern from reference examples:

```typescript
const result = await agent.invoke({
  messages: [
    { role: "system", content: systemPrompt },
    { role: "user", content: userQuestion }
  ],
  tools: [kubectlGetTool, kubectlDescribeTool, kubectlLogsTool],
  maxIterations: 10,
  onToolCall: (tool, args, result) => {
    // Print visible reasoning
    console.log(`🔧 Tool: ${tool.name}`);
    console.log(`   Args: ${JSON.stringify(args)}`);
    console.log(`   Result: ${result}`);
  }
});
```

## Reference Examples

Patterns to follow:
- **kubectl tools**: https://github.com/vfarcic/dot-ai/blob/main/src/core/kubectl-tools.ts
- **Agent with tools**: https://github.com/vfarcic/dot-ai/blob/main/src/tools/query.ts

## Out of Scope (Future Work)

- MCP interface (CLI only for POC)
- Write operations (apply, delete, patch)
- Authentication/RBAC integration
- Web UI
- Conversation memory (each query is independent)
- Streaming responses

## Dependencies

- `kubectl` CLI installed and in PATH
- Valid kubeconfig with cluster access
- `ANTHROPIC_API_KEY` environment variable

## Testing

**Every milestone must be tested against a real cluster. Do not skip testing.**

**Prerequisites:** Docker running, ports 80/443 free

**Start cluster:**
```bash
cd ~/Documents/Repositories/spider-rainbows && ./setup-platform.sh kind
```

**Tear down cluster:**
```bash
cd ~/Documents/Repositories/spider-rainbows && echo "y" | ./destroy.sh
```

## Design Decisions

### 2026-01-14: LangGraph for Agentic Loop
**Decision**: Use `@langchain/langgraph` with `createReactAgent` instead of older LangChain agent patterns.
**Rationale**: LangGraph is the current recommended approach for building agents (2025+). The older `AgentExecutor` pattern is being deprecated.
**Impact**: Added `@langchain/langgraph` to dependencies. M2 implementation will use `createReactAgent` from `@langchain/langgraph/prebuilt`.

### 2026-01-14: Pin Zod to 3.25.67
**Decision**: Pin Zod version to 3.25.67 using npm overrides.
**Rationale**: Zod 3.25.68+ has a TypeScript bug causing "Type instantiation is excessively deep" errors with LangChain's `tool()` function. See [langchainjs #8468](https://github.com/langchain-ai/langchainjs/issues/8468).
**Impact**: Added `overrides` section to package.json. Must maintain this pin until LangChain or Zod fixes the issue.

### 2026-01-14: Tool Definition Pattern
**Decision**: Use LangChain's `tool()` function from `@langchain/core/tools` with Zod schemas.
**Rationale**: This is the current recommended pattern for defining tools. Simpler than `DynamicStructuredTool` class, better TypeScript integration with the Zod pin.
**Impact**: All kubectl tools follow this pattern. See `src/tools/kubectl-get.ts` for reference implementation.

### 2026-01-14: Test Cluster Setup
**Decision**: Use the spider-rainbows Kind cluster setup for testing.
**Rationale**: Provides realistic complexity with multiple namespaces (default, argocd, ingress-nginx), various resource types (deployments, services, ingress, configmaps), and real workloads. Better for demo scenarios than a bare cluster.
**Impact**: Testing requires running `~/Documents/Repositories/spider-rainbows/setup-platform.sh` with Kind option. Prerequisites: Docker running, ports 80/443 free.
**Setup command**: `~/Documents/Repositories/spider-rainbows/setup-platform.sh` (select option 1 for Kind)

---

## Progress Log

### 2026-01-14: M1 Complete
- Created project structure: `package.json`, `tsconfig.json`
- Implemented `src/utils/kubectl.ts` - shared kubectl execution helper with subprocess pattern
- Implemented `src/tools/kubectl-get.ts` - first tool using LangChain `tool()` function with Zod schema
- Created `src/index.ts` - CLI entry point (M1 test mode)
- Fixed Zod TypeScript bug by pinning to 3.25.67 with npm overrides
- Tested against Kind cluster (spider-rainbows setup) - successfully returned 21 pods across 5 namespaces
- Created learning-focused documentation: `docs/kubectl-tools.md`
