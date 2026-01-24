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

## Research Approach

**Primary sources first, then reference implementations.**

### Official Documentation (Primary)
- **MCP Specification**: https://modelcontextprotocol.io/
- **MCP TypeScript SDK**: Official SDK documentation and examples
- **MCP tool patterns**: How the spec recommends structuring tools

### Questions to Answer During Research
1. What does the MCP spec say about tool definition structure?
2. What are current MCP SDK versions and their recommended patterns?
3. What output formats do MCP clients expect? (JSON vs YAML vs plain text)
4. How should errors be returned in MCP context?
5. What are the official examples for MCP servers with similar tools?

### Reference Implementations
- **Viktor's dot-ai**: One example of MCP + kubectl integration - useful for seeing how pieces connect, but may use different patterns
- **Official MCP examples**: From the MCP SDK repository


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
  - Study MCP specification and official TypeScript SDK documentation
  - Research current MCP SDK versions and patterns (landscape changing rapidly)
  - Review official MCP examples and community servers for patterns
  - Reference Viktor's dot-ai for integration architecture (not implementation details)
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

## Reference Sources

- **MCP specification**: https://modelcontextprotocol.io/ (primary)
- **MCP TypeScript SDK**: Official SDK and examples
- **Viktor's dot-ai**: Reference for integration architecture

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
