# Cluster Whisperer: Architecture Research & Refactor Decision

**Date**: 2026-04-04  
**Status**: Decision reached — refactor recommended  
**Repo**: [cluster-whisperer](https://github.com/wiggitywhitney/cluster-whisperer)

---

## Current State

Cluster Whisperer is a developer-facing platform intelligence tool. It lets developers ask natural language questions about their Kubernetes cluster and receive answers and actions. Currently it has three interfaces:

1. **CLI** — direct terminal use
2. **MCP server** — a wrapper around the LangGraph agent, making it available to Claude Code and other MCP clients
3. **REST API** — receives live updates from a Kubernetes controller

Internally, all three interfaces invoke the same **LangGraph agent**, which:
- Takes a natural language question
- Calls Kubernetes tools (kubectl, vector database search, etc.) in an orchestrated graph
- Calls the LLM API to reason through findings
- Returns an answer

The MCP server is not a native MCP tool server — it is a wrapper that invokes the LangGraph agent as an external process via API. When Claude Code calls "cluster-whisperer via MCP," it is invoking a separate intelligence instance, not using Claude Code's built-in reasoning.

The KCD Texas / SRE Day talk abstract reflects this current design ("built from scratch with LangGraph, a vector database, and OpenTelemetry instrumentation… available to the coding assistant via MCP and CLI").

---

## Why This Might Need Refactoring

These are the concerns that prompted research:

**1. Invoking intelligence via API is redundant when inside Claude Code**  
When a developer uses Cluster Whisperer through Claude Code's MCP integration, two LLM instances are running: Claude Code itself, and the LangGraph agent inside Cluster Whisperer. The agent is calling the Anthropic API to reason about Kubernetes state — but Claude Code already has that reasoning capability. This is unnecessary complexity and cost.

**2. Michael's argument: meet developers where they already are**  
Michael Forrester's position: the better architecture is to write the Kubernetes business logic as MCP tool handlers, let Claude Code supply the intelligence, and enforce guardrails via which APIs the tools expose. Developers using Claude Code as their coding assistant would naturally get platform intelligence in the same context as their code work.

**3. Scope/context concern (Whitney's own question)**  
If the MCP server exposes the full LangGraph agent, Claude Code has the developer's entire codebase in context alongside platform queries. A developer debugging "why is my pod crashing" shouldn't have their feature branch code mixed into the cluster investigation context. A standalone agent with a narrow context window is safer. This was the question Whitney posed to Michael that wasn't fully answered in their conversation.

**4. KCD Austin talk may need rethinking**  
If the right architecture is MCP tools with native logic, the talk should reflect that. "Custom AI agents are wildly useful" may need to become "here's when to use a standalone agent and when to use native MCP tools" — a more nuanced and defensible thesis.

---

## Research Results

*Thorough citations provided. Do not re-research these questions.*

### MCP and LangGraph are not alternatives

The most common misconception: switching from LangGraph to MCP is like switching agent frameworks. It is not.

- **MCP** (Model Context Protocol): a *protocol* for packaging and exposing tools so any compatible AI client can call them. MCP handles: standardized tool invocation, input/output schema, multi-client compatibility. MCP does NOT handle: state management, multi-step orchestration, conditional branching, retry logic, human-in-the-loop pausing, or context window control.

- **LangGraph**: an *orchestration framework* for building stateful multi-step agent workflows with control flow. It handles the things MCP doesn't.

They operate at different layers and are complementary, not competing.

**Source**: "LangGraph = Orchestration framework (how to chain operations). MCP = Tool distribution protocol (how to package and share tools)." — [Medium, Karan Bhutani, "Your LangGraph Agent Already Does What You Think MCP Does"](https://medium.com/@karanbhutani477/your-langgraph-agent-already-does-what-you-think-mcp-does-0200bf8162e2)

**Source**: "MCP handles tool connections while LangChain/LangGraph handle orchestration logic. MCP operates at the protocol layer; LangGraph works at the application layer." — [Digital Applied: MCP vs LangChain vs CrewAI](https://www.digitalapplied.com/blog/mcp-vs-langchain-vs-crewai-agent-framework-comparison)

---

### The tool handler design pattern (resolves Whitney's scope concern)

The key insight that resolves the context pollution concern: **write the Kubernetes business logic directly into the MCP tool handlers**. The tool handler does the heavy lifting (queries the cluster, processes data, structures the output). Claude Code decides which tool to call and what to say to the user. Claude Code's context window only sees the clean, structured output — not raw cluster state mixed with codebase context.

This is NOT "Claude Code provides all the intelligence." The intelligence about *how to investigate the cluster* lives in the tool handler. Claude Code provides the reasoning about *what to do with the result*.

This directly addresses the scope concern: because the tool handler controls what it returns, it controls what enters Claude Code's context. Cluster state and application code are no longer mixed in the same window.

**Contrast with current design**: The LangGraph agent wrapper passes the developer's question to an external LLM call, which has whatever context the agent provides. The MCP tool handler design keeps that logic in-process and returns only what the tool decides to surface.

---

### Context pollution quantified

MCP tool schemas are not free. Each tool definition costs tokens before the conversation begins.

> "One team reported 143,000 of 200,000 tokens consumed by three MCP servers — 72% of available context gone before the user types a single message." — [Apideck: Your MCP Server Is Eating Your Context Window](https://www.apideck.com/blog/mcp-server-eating-context-window-cli-alternative)

> "MCP tools can consume over 66,000 tokens of context before a conversation even starts — burning through a third of Claude Sonnet 4.5's 200k token window just loading tools." — [Medium: Optimizing Context with MCP Tool Search](https://nayakpplaban.medium.com/optimizing-context-with-mcp-tool-search-solving-the-context-pollution-crisis-with-dynamic-loading-224a9df57245)

**Mitigation**: Anthropic's `defer_loading: true` feature loads tool definitions on demand rather than at session start. A Cluster Whisperer MCP server with deferred loading would only consume tokens when the developer actually invokes a platform tool.

---

### Guardrails: MCP vs standalone agent

Both approaches support guardrails, but they work differently.

**MCP server guardrails:**
- API surface control (only expose the tools you choose to expose)
- RBAC pass-through (Kubernetes native access controls)
- `--read-only` flag (blocks all write operations)
- The MCP spec defines scope minimization as a best practice (progressive least-privilege) but does not enforce it — guardrails are opt-in server design

**Critical**: The official MCP spec places responsibility for additional guardrails on the *client*, not the server: "The MCP client SHOULD implement additional checks and guardrails to mitigate potential code execution attack vectors." — [MCP Security Best Practices](https://modelcontextprotocol.io/specification/draft/basic/security_best_practices)

**LangGraph agent guardrails:**
- Middleware (pre/post-model hooks for input/output validation)
- Built-in PII detection and content filtering
- Human-in-the-loop pausing (first-class in LangGraph 1.0)
- Full control over what enters the context window
- Observability via LangSmith

**Interpretation**: LangGraph is actually stronger on guardrails if you need PII detection, content filtering, or human-in-the-loop checkpoints. MCP guardrails depend on what the client (Claude Code) chooses to enforce. However, for Cluster Whisperer's use case (read/inspect queries with optional write operations), `--read-only` by default + Kubernetes RBAC may be sufficient.

---

### Token economics: CLI vs MCP

A Scalekit benchmark across 75 tasks compared CLI and MCP approaches directly:

> "MCP costs 4 to 32x more tokens than CLI for identical operations." — [Scalekit: MCP vs CLI Benchmark](https://www.scalekit.com/blog/mcp-vs-cli-use)

> "Scalekit recorded a 28% failure rate on MCP calls to GitHub's server." — same source

Note: the 28% failure rate is specific to GitHub's MCP server and may not generalize to a well-designed internal server. But the token cost differential is structural and applies broadly.

**Interpretation for Cluster Whisperer**: The standalone CLI remains the most token-efficient and reliable path for automation, scripting, and developers not using Claude Code. The MCP server is the right integration for Claude Code users — not a replacement for the CLI.

---

### Real-world precedent: Red Hat kubernetes-mcp-server

Red Hat ships a production Kubernetes MCP server (`containers/kubernetes-mcp-server`) as a single binary. Key design decisions directly applicable to Cluster Whisperer:

> "Configurable access modes: read-only, non-destructive, or fully unprotected operations." — [Red Hat Developer: Kubernetes MCP Server](https://developers.redhat.com/articles/2025/09/25/kubernetes-mcp-server-ai-powered-cluster-management)

> "Respects OpenShift's native role-based access controls." — same source

> "By default, every tool must be set to read-only, and require explicit user approval for any write action." — [Red Hat Developer: 3 MCP Servers You Should Be Using](https://developers.redhat.com/articles/2025/11/04/3-mcp-servers-you-should-be-using)

Komodor's production Kubernetes MCP server adds human-in-the-loop confirmation for destructive operations: "For mutation commands like delete or apply, implementing an approval flow where the MCP server requests user confirmation before execution prevents the LLM from accidentally deleting deployments." — [Komodor: Building a Kubernetes MCP Server](https://komodor.com/blog/from-blueprint-to-production-building-a-kubernetes-mcp-server/)

---

### Does the workflow need LangGraph?

LangGraph earns its complexity for stateful multi-step workflows with:
- Conditional branching (if X then go to node Y, else node Z)
- Human-in-the-loop pausing mid-workflow
- State checkpointing across steps
- Complex retry logic

Cluster Whisperer's core workflow is relatively linear: question → query cluster → process results → answer. This does not require LangGraph's full graph execution model. A plain Anthropic SDK call with tools defined as functions would achieve the same result with less framework overhead.

**Exception**: If Cluster Whisperer ever needs to handle complex incident response workflows (multi-step diagnosis → propose fix → get human approval → apply fix → verify), LangGraph adds real value. The current use case doesn't require it.

---

## Where Guardrails Live: The Layered Defense Argument

Michael's approach makes a stronger security argument than any application-layer guardrail:

**Layer 1 — Application (LangGraph middleware)**: enforced in code. Inside the blast radius of bugs, prompt injection attacks, or framework vulnerabilities.

**Layer 2 — Protocol (MCP tool surface)**: enforced by which tools you expose. Still in the application. Can be bypassed if the server is misconfigured or compromised.

**Layer 3 — Infrastructure (Kubernetes RBAC)**: enforced at the cluster, completely outside the application. Even a compromised or misconfigured agent cannot exceed the service account's RBAC permissions. This is the most trustworthy layer.

Michael's specific approach: give the MCP server's service account only the Kubernetes permissions it needs (`get`, `describe`, `logs`). The server can have prompt guidance saying "only use these operations," but the real enforcement is the service account. Even if Claude Code tries to call `kubectl delete`, Kubernetes rejects it. The application doesn't need to enforce what the cluster already enforces.

**This is the "confused deputy" defense**: the server cannot be tricked or misconfigured into doing more than the cluster allows. It's a fundamentally more robust security posture than any amount of application-level guardrails.

---

## Decision

**Refactor the MCP server from a LangGraph agent wrapper to native MCP tool handlers.**

There is no compelling use case for a CLI backed by a LangGraph agent. The natural language interface doesn't add value for scripting or automation — those use cases call the REST API directly and get structured output. The LangGraph agent wrapper served as a way to expose existing logic via MCP, but the right architecture is to put the Kubernetes business logic directly in the MCP tool handlers.

Specifically:
1. **MCP server**: rewrite as native tool handlers containing the Kubernetes business logic directly. Read-only by default. Service account RBAC enforces the command surface at the cluster level — prompt guidance in the server describes what's available, but Kubernetes RBAC is the actual enforcement. Kyverno/org policy integration. Deferred tool loading to minimize token cost.
2. **LangGraph**: remove from the MCP path. Retain only if complex multi-step orchestration with human-in-the-loop checkpoints becomes necessary (current Q&A workflow doesn't require it).
3. **CLI / REST API**: separate decision, unaffected by the MCP refactor. CLI may become a thin frontend that calls the MCP server, or may be retired.

---

## Blog Post

**"Why I refactored my platform interface agent into an MCP server"**

The story:
1. Built a Kubernetes platform agent with LangGraph
2. Added an MCP wrapper so Claude Code could use it
3. Realized the MCP wrapper was invoking a redundant LLM instance — two intelligences doing one job
4. Refactored to native MCP tool handlers: business logic in the tools, Claude Code provides the orchestration
5. Added cluster-side RBAC as the actual guardrail instead of application-layer enforcement

This is more honest and more interesting than "here are the tradeoffs between two valid architectures." It's a specific decision with a specific rationale.

---

## Talk Implications (KCD Texas / SRE Day)

The current abstract argues "custom AI agents are wildly useful as platform interfaces." That's still true — but the talk can be richer: show the original LangGraph design, explain what prompted the refactor, and demonstrate the MCP tool handler approach with cluster-side RBAC enforcement.

The thesis becomes: *the right platform interface agent isn't a standalone agent at all — it's native tools that meet developers in the AI client they're already using, with guardrails enforced by the cluster, not the application.*

---

## Open Design Questions

*Direction confirmed: MCP native tool handlers + cluster-side RBAC. These questions need their own research phases before implementation begins. Each is a PRD milestone in the cluster-whisperer repo.*

### 1. Investigation Strategy Transfer

The current `prompts/investigator.md` system prompt orchestrates multi-step investigation strategies that are not captured in tool descriptions:
- Fall back to `kubectl get crd` when vector search is unavailable
- Ask clarifying questions when vector results are ambiguous (the 20-decoy-ManagedService scenario)
- Don't guess which ManagedService to deploy without catalog validation
- Strategy: `search vector DB → ambiguous → ask user → search again with context → validate → deploy`

Tool descriptions guide *when* to use a tool, not *how to reason across a multi-tool investigation*. In the MCP model, this strategy needs to live somewhere. MCP has a `prompts` primitive designed for exactly this — you can expose an `investigate-cluster` prompt that gives Claude Code the investigation strategy as a reusable prompt. This needs to be researched and tested.

**Questions to answer**: Does the MCP `prompts` primitive adequately replace `investigator.md`? How do you test that Claude Code's reasoning with the MCP prompt reliably handles the 20-decoy scenario? What breaks?

### 2. Non-Claude-Code Interfaces

"Meet developers where they are" correctly prioritizes Claude Code as the primary interface. But other interfaces exist and have legitimate use cases:
- **Serve endpoint / REST API**: receives live updates from a Kubernetes controller, serves developers not using Claude Code
- **Thin-client mode** (PRD #53): cluster investigation for developers in terminals, web UIs, Slack
- **Future integrations**: Slack bots, web dashboards, CI/CD gates

For these paths, something server-side still needs to orchestrate multi-step investigation. This might not be LangGraph — a plain Anthropic SDK agent loop may suffice — but it's agent-like orchestration. The MCP refactor decision applies specifically to the MCP server path. The serve endpoint architecture is a separate question.

**Questions to answer**: What orchestrates multi-step investigation for non-Claude-Code clients? Does the serve endpoint keep a lightweight agent loop (Anthropic SDK, not LangGraph)? Or do all paths converge on Claude Code?

### 3. Investigation-Level Observability

Current architecture: one `investigate` tool call → one trace → complete reasoning chain nested inside it as a flame graph. You can open Datadog and see the entire investigation.

In the MCP model with granular tools: Claude Code calls `kubectl_get`, then `vector_search`, then `kubectl_apply` as separate MCP invocations. Each creates an independent trace. There is no parent span tying them together into "this was one investigation."

Each individual tool handler can create OTel spans with Weaver schema attributes — that part is straightforward. What's lost is the investigation-level correlation. This is directly relevant to the KubeCon demo ("Vote 3: watch the investigation unfold in Datadog").

Potential solutions: pass a correlation ID through tool calls, use MCP session context to group traces, expose a session start/end tool that creates the parent span, or accept fragmented traces for the MCP path.

**Questions to answer**: Which solution fits the Weaver schema and existing tracing conventions? What does the Datadog dashboard look like after the refactor — is it still demo-worthy?

---

## Sources

| Source | Key Finding |
|---|---|
| [Medium, Karan Bhutani](https://medium.com/@karanbhutani477/your-langgraph-agent-already-does-what-you-think-mcp-does-0200bf8162e2) | MCP is protocol, LangGraph is orchestrator — not alternatives |
| [Digital Applied: MCP vs LangChain vs CrewAI](https://www.digitalapplied.com/blog/mcp-vs-langchain-vs-crewai-agent-framework-comparison) | Capability comparison table |
| [MCP Security Best Practices (Official Spec)](https://modelcontextprotocol.io/specification/draft/basic/security_best_practices) | Client is responsible for guardrails, not the protocol |
| [LangChain Guardrails Docs](https://docs.langchain.com/oss/python/langchain/guardrails) | PII detection, human-in-the-loop, middleware |
| [Apideck: MCP Context Window](https://www.apideck.com/blog/mcp-server-eating-context-window-cli-alternative) | 143K/200K context consumed; 4–32x token cost vs CLI |
| [Scalekit: MCP vs CLI Benchmark](https://www.scalekit.com/blog/mcp-vs-cli-use) | 28% MCP failure rate; token cost benchmark across 75 tasks |
| [Red Hat: Kubernetes MCP Server](https://developers.redhat.com/articles/2025/09/25/kubernetes-mcp-server-ai-powered-cluster-management) | Production reference; read-only mode; RBAC |
| [Red Hat: 3 MCP Servers](https://developers.redhat.com/articles/2025/11/04/3-mcp-servers-you-should-be-using) | Read-only defaults; human approval for writes |
| [Komodor: Building Kubernetes MCP Server](https://komodor.com/blog/from-blueprint-to-production-building-a-kubernetes-mcp-server/) | Human-in-the-loop for destructive operations |
| [Context Pollution / Dynamic Loading (Medium)](https://nayakpplaban.medium.com/optimizing-context-with-mcp-tool-search-solving-the-context-pollution-crisis-with-dynamic-loading-224a9df57245) | 66K tokens consumed before first message; deferred loading |
| [MCP vs CLI Decision Framework](https://manveerc.substack.com/p/mcp-vs-cli-ai-agents) | Per-integration decision model; when CLI wins |
| [LangGraph 1.0 Release](https://blog.langchain.com/langchain-langgraph-1dot0/) | October 2025 stable release; human-in-the-loop features |
| [ITNEXT: MCP vs Agent Orchestration](https://itnext.io/mcp-vs-agent-orchestration-frameworks-langgraph-crewai-etc-ec6bd611aa4d) | Architectural distinction between protocol and orchestration layers |
