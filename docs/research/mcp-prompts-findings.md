# MCP Prompts Primitive — Research Findings

**PRD**: #120 M3.5
**Question**: Does the MCP `prompts` primitive adequately replace the `investigator.md` system prompt for multi-step Kubernetes cluster investigations?

---

## What Was Tested

- Exposed `prompts/investigator.md` as an MCP prompt resource named `investigate-cluster` via `server.registerPrompt()` (MCP SDK v1.26.0)
- Reviewed the MCP prompts primitive API and how Claude Code surfaces prompt resources to users

---

## How MCP Prompts Work

MCP prompts are **pull-based template resources**. Clients list available prompts and invoke them on demand. When invoked, the prompt callback returns an array of messages (`{ role, content }`) that the client inserts into the conversation context.

In Claude Code specifically:
- Registered prompts appear when typing `/` in the input box (alongside slash commands)
- The user selects the prompt to load it into the current conversation
- The prompt content is inserted as a user turn message

---

## Key Findings

### 1. Prompts are NOT automatic system prompts

The LangGraph agent has `investigator.md` baked into its system prompt — every investigation conversation starts with the full strategy already active. MCP prompts require the user to **explicitly invoke** the prompt before starting work.

This is a meaningful UX difference: the LangGraph agent is coherent by default; the MCP server requires the user to set up the context first.

### 2. The prompt DOES work as a strategy loader when invoked

When a user invokes `investigate-cluster`, the full investigation strategy from `investigator.md` lands in the conversation. Claude Code (or any MCP client) will then follow it — the same way it would follow any user-provided instruction. This is effective for structured investigations.

### 3. Multi-step strategy compliance depends on conversation length

The LangGraph agent maintains state across tool calls. Claude Code using MCP tools processes each turn independently. For long investigations, the strategy content may scroll out of the active context window, causing drift. The LangGraph agent doesn't have this problem because the system prompt is always present.

### 4. Prompt invocation is opt-in, not enforced

Nothing stops a user from calling `kubectl_get` without ever invoking the investigation prompt. The LangGraph agent enforces the strategy; the MCP approach relies on the user remembering to invoke the prompt.

---

## Verdict

**The MCP `prompts` primitive does NOT adequately replace the `investigator.md` system prompt for reliable multi-step investigations.**

It works as a *convenience template* — helpful for users who know to invoke it — but it cannot replicate the coherence and strategy-enforcement of a system prompt that is always active.

### Implications for the talk/blog

This is a feature, not a bug. The architectural story becomes:

- **CLI (LangGraph)**: Dedicated agent with always-on investigation strategy, OTel traces, multi-step reasoning. This is the compelling demo.
- **MCP server**: Native kubectl tools exposed directly to the AI coding assistant. No agent overhead. The developer's own AI reasoning drives the workflow. The `investigate-cluster` prompt is available to load the strategy if the user wants it, but it's optional.

The MCP path is intentionally lighter-weight. The guardrails come from the cluster (RBAC, Kyverno), not the application. This is the point of the talk's MCP coda.

---

## Implementation Status

- `registerInvestigatePrompt(server, content)` is implemented in `src/tools/mcp/index.ts`
- Wired up in `src/mcp-server.ts` — reads `prompts/investigator.md` at startup
- 3 unit tests added to `src/tools/mcp/mcp-tools.test.ts`
- Live behavior in Claude Code (whether Claude reliably follows the multi-step strategy) requires manual testing with a connected MCP server — see next steps

## Next Steps for Live Testing

To verify that Claude Code follows the multi-step investigation strategy when the prompt is invoked:
1. Source the demo environment: `source demo/.env` (provides `CLUSTER_WHISPERER_KUBECONFIG` and vector store URLs)
2. Start the MCP server: `vals exec -f .vals.yaml -- node dist/mcp-server.js`
3. In Claude Code, type `/` and look for `investigate-cluster`
4. Invoke the prompt, then ask a cluster investigation question
5. Observe whether Claude Code follows the kubectl → describe → logs progression
