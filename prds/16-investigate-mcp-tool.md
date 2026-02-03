# PRD #16: High-Level Investigate MCP Tool

## Problem Statement

The current MCP server exposes low-level kubectl tools (`kubectl_get`, `kubectl_describe`, `kubectl_logs`). When Claude Code uses these tools to investigate a cluster issue, each tool call creates a separate trace. The result is fragmented observability - you can see individual tool calls but not the complete investigation as a single unit.

The CLI mode already has a LangGraph agent that:
- Reasons about what tools to call
- Executes multiple tool calls in sequence
- Produces complete traces with all operations nested under one root span
- Streams verbose thinking and event output

This agent exists and works. The MCP server just doesn't use it.

## Solution Overview

Replace the low-level MCP tools with a single high-level `investigate` tool that wraps the existing LangGraph agent:

```text
Current (fragmented traces):
Claude Code → kubectl_get (trace 1)
           → kubectl_describe (trace 2)
           → kubectl_logs (trace 3)

Proposed (complete trace):
Claude Code → investigate("find the broken pod")
                    └── LangGraph agent
                          ├── kubectl_get
                          ├── kubectl_describe
                          └── kubectl_logs
              (all in one trace)
```

## Architectural Decision

This PRD represents an intentional trade-off:

| Aspect | Low-level tools (removed) | High-level investigate (new) |
|--------|---------------------------|------------------------------|
| Tracing | Fragmented | Complete |
| User visibility | Claude shows reasoning in chat | Black box - just input/output |
| LLM cost | One LLM (Claude) | Two LLMs (Claude + agent) |
| Intervention | Claude can course-correct | Can't intervene mid-investigation |

**Why we're choosing this**: Complete tracing is the priority for the KubeCon demo. The agent's reasoning is captured in trace attributes (when `OTEL_TRACE_CONTENT_ENABLED=true`), so it's observable in Datadog even though users don't see it in real-time.

**Future consideration**: MCP spec supports `notifications/progress` for streaming updates, but Claude Code doesn't display them yet (GitHub issue #3174). If/when that ships, the agent's verbosity could surface to users.

## Success Criteria

- [ ] Single `investigate` MCP tool exposed (replaces kubectl_get, kubectl_describe, kubectl_logs)
- [ ] Tool wraps existing LangGraph agent from CLI mode
- [ ] Complete traces visible in Datadog with proper hierarchy
- [ ] Agent thinking/reasoning captured in trace attributes (when content tracing enabled)
- [ ] Error cases produce proper ERROR status spans

---

## Milestones

### Milestone 1: Create Investigate MCP Tool
**Status**: Not Started

**Objective**: Add a new `investigate` tool to the MCP server that calls the existing LangGraph agent.

**Implementation**:
- [ ] Create `investigate` tool in `src/tools/mcp/index.ts`
- [ ] Wrap handler with `withMcpRequestTracing()` (from PRD-15)
- [ ] Call existing `createAgent()` and `invoke()` from CLI code
- [ ] Return agent's final answer as MCP result
- [ ] Handle errors and set appropriate span status

**Success Criteria**:
- Tool accepts natural language question
- Returns investigation results
- Creates proper root span for tracing

---

### Milestone 2: Remove Low-Level Tools
**Status**: Not Started

**Objective**: Remove the low-level kubectl tools from MCP registration.

**Implementation**:
- [ ] Remove `kubectl_get` tool registration
- [ ] Remove `kubectl_describe` tool registration
- [ ] Remove `kubectl_logs` tool registration
- [ ] Clean up any unused imports/code

**Success Criteria**:
- MCP server exposes only `investigate` tool
- No dead code remaining

---

### Milestone 3: Refactor Agent for Reuse
**Status**: Not Started

**Objective**: Ensure the LangGraph agent can be cleanly invoked from both CLI and MCP modes.

**Implementation**:
- [ ] Extract agent creation/invocation into shared module if needed
- [ ] Handle different output modes (CLI streams to console, MCP returns result)
- [ ] Ensure tracing context propagates correctly in MCP mode
- [ ] Verify agent tools work without CLI-specific assumptions

**Success Criteria**:
- Same agent code powers both CLI and MCP
- No duplicate agent implementations

---

### Milestone 4: End-to-End Validation
**Status**: Not Started

**Objective**: Verify complete traces flow from MCP tool calls through to Datadog.

**Validation Steps**:
- [ ] Restart Claude Code to pick up changes
- [ ] Ask Claude Code to investigate a cluster issue
- [ ] Verify single trace appears in Datadog APM
- [ ] Verify trace hierarchy: MCP root → agent → tools → kubectl
- [ ] Verify LLM spans include prompts/completions (when content enabled)
- [ ] Verify error scenarios produce ERROR status spans

**Success Criteria**:
- Traces visible at https://app.datadoghq.com/apm/traces?query=service%3Acluster-whisperer
- Complete investigation captured in one trace

---

## Progress Log

### 2026-02-03: PRD Created

**Context**: This PRD emerged from a design discussion about MCP architecture trade-offs.

**Key decisions**:
1. Complete tracing is higher priority than real-time user visibility
2. Reuse existing LangGraph agent rather than building something new
3. Remove low-level tools to prevent Claude Code from fragmenting traces
4. Agent verbosity is captured in traces, not shown to users (until MCP notifications land)

**References**:
- PRD-15 implemented `withMcpRequestTracing()` which this PRD will use
- GitHub issue anthropics/claude-code#3174 tracks MCP notification display
- Journal entry 2026-02-03 captures full decision context

---

## Technical Context

### Existing Code to Reuse

| Component | Location | Purpose |
|-----------|----------|---------|
| `createAgent()` | `src/agent/index.ts` | Creates LangGraph agent |
| `withMcpRequestTracing()` | `src/tracing/context-bridge.ts` | MCP root span wrapper (PRD-15) |
| Tracing config | `.mcp.json` | Environment variables for OTLP export |

### Files to Modify

| File | Changes |
|------|---------|
| `src/tools/mcp/index.ts` | Remove low-level tools, add investigate |
| `src/agent/index.ts` | May need refactoring for MCP reuse |

---

## References

- PRD-15: MCP Server Tracing (implemented tracing infrastructure)
- Journal context: `journal/context/2026-02/2026-02-03.md`
- MCP notifications issue: https://github.com/anthropics/claude-code/issues/3174
