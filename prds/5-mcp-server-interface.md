# PRD #5: MCP Server Interface

**Status**: Not Started
**Created**: 2026-01-24
**GitHub Issue**: [#5](https://github.com/wiggitywhitney/cluster-whisperer/issues/5)

---

## Problem Statement

The current kubectl tools are only accessible via CLI. This limits integration with MCP-compatible clients like Claude Code, Cursor, and other AI development tools. Platform engineers need these investigation tools available in their existing workflows without switching to a separate CLI.

## Solution

Create an MCP server that exposes the existing kubectl tools (get, describe, logs) as MCP tools. Any MCP client can then use these tools directly. The CLI remains intact as an alternative interface.

### Key Insight: MCP vs CLI Architecture

| CLI Agent | MCP Server |
|-----------|------------|
| Has its own reasoning/thinking | Tools only - no reasoning |
| Orchestrates tool calls | Exposes tools for external orchestration |
| Returns natural language | Returns data for client LLM to interpret |

The MCP server exposes the raw tools. The MCP client's LLM (Claude, etc.) does the reasoning and orchestration - just like our CLI agent does now, but externally.

---

## Viktor's Implementation Reference

**Before implementation, research Viktor's MCP patterns in dot-ai:**

### Files to Study
- MCP server setup and configuration
- How tools are exposed via MCP
- Output format choices (JSON vs YAML vs plain text)
- Schema validation patterns
- Error handling in MCP context

### Questions to Answer During Research
1. How does Viktor structure MCP tool definitions vs CLI tool definitions?
2. What output format does he use for MCP responses?
3. How does he handle errors in MCP context?
4. Does he share code between CLI and MCP, or are they separate?
5. What MCP SDK/library does he use?

### Decisions to Make
- Reuse existing tool code or create MCP-specific wrappers?
- Output format: JSON, YAML, or preserve kubectl's native output?
- Error response format for MCP clients

---

## Success Criteria

- [ ] MCP server exposes kubectl_get, kubectl_describe, kubectl_logs tools
- [ ] Tools work correctly when called from Claude Code or another MCP client
- [ ] CLI continues to work unchanged
- [ ] Documentation explains MCP concepts and our implementation

## Milestones

- [ ] **M1**: Research Phase
  - Study Viktor's dot-ai MCP implementation
  - Research current MCP SDK versions and patterns (landscape changing rapidly)
  - Research MCP output format best practices
  - Document findings and decisions in `docs/mcp-research.md`
  - Update this PRD with specific implementation decisions

- [ ] **M2**: MCP Server Setup
  - Set up MCP server infrastructure
  - Configure tool registration
  - Create `docs/mcp-server.md` explaining MCP concepts and our architecture
  - Manual test: server starts and responds to tool list request

- [ ] **M3**: Expose kubectl Tools via MCP
  - Wrap/adapt existing kubectl tools for MCP
  - Determine output format based on research
  - Schema validation for MCP inputs
  - Manual test: tools work when called from MCP client

- [ ] **M4**: Integration and Polish
  - Test with Claude Code as MCP client
  - Error handling for MCP context
  - Update README with MCP usage instructions
  - Verify CLI still works unchanged

## Technical Approach

*To be determined during M1 research phase. Key decisions:*

- MCP SDK choice and version
- Code sharing strategy between CLI and MCP
- Output format strategy
- Configuration approach (how clients discover/connect to server)

## Reference Examples

- **Viktor's dot-ai**: Primary reference for MCP patterns
- **MCP specification**: https://modelcontextprotocol.io/

## Out of Scope

- MCP resources (read-only data the client can access)
- MCP prompts (pre-built prompt templates)
- Authentication/authorization (future work)
- Remote MCP server deployment (local only for POC)

## Dependencies

- Existing kubectl tools (from PRD #1)
- MCP SDK (to be determined in research)

## Testing

Test against real cluster using spider-rainbows Kind setup.

**MCP client testing**: Use Claude Code or `mcp` CLI tool to invoke tools.

---

## Design Decisions

*Decisions will be logged here as they're made during implementation.*

---

## Progress Log

*Progress will be logged here as milestones are completed.*
