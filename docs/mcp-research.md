# MCP Research Findings

**PRD**: #5 - MCP Server Interface
**Date**: 2026-01-25
**Status**: Research Complete

---

## Research Questions Answered

### 1. What does the MCP spec say about tool definition structure?

**Source**: [MCP Specification](https://modelcontextprotocol.io/docs/concepts/tools) (Protocol Revision 2025-06-18)

Tools in MCP have these components:

```typescript
{
  name: string,           // Unique identifier (e.g., "kubectl_get")
  title?: string,         // Human-readable display name
  description: string,    // What the tool does (LLM reads this)
  inputSchema: object,    // JSON Schema for parameters
  outputSchema?: object,  // Optional JSON Schema for structured output
  annotations?: object    // Hints about behavior (readOnlyHint, etc.)
}
```

**Tool Results** can be:
- **Unstructured**: `content` array with text/image/audio items
- **Structured**: `structuredContent` object matching `outputSchema`

For backward compatibility, structured tools should also include serialized JSON in a text content block.

**Error Handling** has two levels:
1. **Protocol errors**: JSON-RPC errors for unknown tools, invalid args
2. **Tool execution errors**: `isError: true` in result for runtime failures

```typescript
// Success
{ content: [{ type: "text", text: "output" }], isError: false }

// Tool execution error
{ content: [{ type: "text", text: "Failed: reason" }], isError: true }
```

### 2. What are current MCP SDK versions and their recommended patterns?

**Package**: `@modelcontextprotocol/sdk` (with `zod` peer dependency)

**Version Status** (as of Jan 2026):
- v1.x: Stable, recommended for production
- v2: Pre-alpha on main branch, stable release expected Q1 2026

**Recommended Installation**:
```bash
npm install @modelcontextprotocol/sdk zod
```

**Server Creation Pattern** (recommended API):
```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const server = new McpServer({
  name: "cluster-whisperer",
  version: "1.0.0"
});

// Define schema separately for reuse
const kubectlGetSchema = z.object({
  resource: z.string().describe("Resource type"),
  namespace: z.string().optional().describe("Namespace")
});

// Use registerTool() - the tool() method is deprecated
server.registerTool(
  "kubectl_get",
  {
    description: "List Kubernetes resources...",
    inputSchema: kubectlGetSchema.shape  // Pass .shape for Zod schemas
  },
  async (input) => {
    // Execute kubectl
    return {
      content: [{ type: "text", text: output }]
    };
  }
);
```

**Transport Options**:
- **stdio**: For local servers (our use case) - process communication
- **Streamable HTTP**: For remote servers

### 3. What output formats do MCP clients expect?

MCP clients accept any text content. The format is up to the server.

**Two concerns were evaluated:**

1. **Token efficiency** (verified by research):
   - JSON uses ~2x more tokens than YAML, ~5x more than plain text
   - See `docs/output-format-research.md` for detailed findings

2. **Downstream data use** (investigated):
   - Vector DB (PRD #7) gets data from a **controller sync**, not from tool output
   - Tool output flows to LLM context only, not to storage
   - No need for JSON structure for downstream processing

**Decision**: Use plain text (tables) for token efficiency.

### 4. How should errors be returned in MCP context?

**Two-tier error handling**:

| Error Type | When | How to Return |
|------------|------|---------------|
| Protocol error | Unknown tool, invalid schema | Throw error (SDK handles JSON-RPC) |
| Execution error | kubectl fails, permission denied | Return `{ content: [...], isError: true }` |

**Example execution error**:
```typescript
return {
  content: [{
    type: "text",
    text: `kubectl failed: ${stderr}`
  }],
  isError: true
};
```

This lets the LLM understand the failure and potentially retry or adjust its approach.

### 5. What are the official examples for MCP servers with similar tools?

**Official Reference Servers** (github.com/modelcontextprotocol/servers):
- **filesystem**: File operations - closest pattern to our command execution
- **git**: Repository operations via tool calls

**Key Pattern from filesystem server**:
- Uses tool annotations (`readOnlyHint`, `idempotentHint`, `destructiveHint`)
- Separates read-only tools from write operations
- Returns structured errors with context

**Viktor's dot-ai** (reference implementation):
- Uses unified executor pattern: `executeKubectlTools(toolName, input)`
- Tool definitions as typed objects with input schemas
- Safety: strips output format flags to control response format
- Exposes as HTTP-based MCP server (different from our stdio approach)

---

## Token Efficiency Analysis

### The Problem

LLMs have limited context windows. kubectl output competes with:
- User's question
- Conversation history
- Agent's reasoning
- Results from other tool calls

More tokens for data = less room for reasoning.

### Format Comparison

Same data (3 pods) in different formats:

**Table Format (current kubectl default)**
```
NAME                      READY   STATUS    RESTARTS   AGE
nginx-deployment-abc123   1/1     Running   0          3d
redis-master-xyz789       1/1     Running   2          5d
api-server-def456         2/2     Running   0          1d
```
~180 characters, ~45 tokens

**YAML Format**
```yaml
items:
- name: nginx-deployment-abc123
  ready: "1/1"
  status: Running
  restarts: 0
  age: 3d
- name: redis-master-xyz789
  ready: "1/1"
  status: Running
  restarts: 2
  age: 5d
- name: api-server-def456
  ready: "2/2"
  status: Running
  restarts: 0
  age: 1d
```
~280 characters, ~70 tokens

**JSON Format**
```json
{"items":[{"name":"nginx-deployment-abc123","ready":"1/1","status":"Running","restarts":0,"age":"3d"},{"name":"redis-master-xyz789","ready":"1/1","status":"Running","restarts":2,"age":"5d"},{"name":"api-server-def456","ready":"2/2","status":"Running","restarts":0,"age":"1d"}]}
```
~270 characters, ~90 tokens (more tokens due to punctuation)

### Token Counts Summary (Illustrative)

| Format | Characters | Est. Tokens | Overhead vs Table |
|--------|-----------|-------------|-------------------|
| Table  | ~180      | ~45         | baseline          |
| YAML   | ~280      | ~70         | +55%              |
| JSON   | ~270      | ~90         | +100%             |

**Note**: Above counts are illustrative estimates for the 3-pod example, not measured with a tokenizer.

### Verified Research Findings

Source: [Piotr Sikora's format comparison study (Dec 2025)](https://www.piotr-sikora.com/blog/2025-12-05-toon-tron-csv-yaml-json-format-comparison)

| Format | Efficiency | Savings vs JSON |
|--------|------------|-----------------|
| Plain text/CSV | ~100% | **80% savings** |
| YAML | 65% | 41% savings |
| JSON | 45% | baseline (most verbose) |

See `docs/output-format-research.md` for full research details.

### Decision

**Use plain text (kubectl's default table format)**:
- 80% more token-efficient than JSON (verified by research)
- LLMs parse tables well
- Tool output does not flow to vector DB (controller syncs that data separately per PRD #7 architecture)
- Matches what human operators expect

---

## Implementation Decisions

Based on this research, here are the recommended decisions for PRD #5:

### SDK Choice
**Use**: `@modelcontextprotocol/sdk` v1.x with `zod`

**Rationale**: Stable, well-documented, TypeScript native, same Zod we already use.

**Note**: The SDK exposes `registerTool()` as the recommended method. The older `tool()` method is deprecated but still works for backward compatibility.

### Transport
**Use**: stdio transport

**Rationale**:
- Local server (runs on user's machine)
- Claude Code and other MCP clients support stdio
- No network overhead, simplest setup

### Code Sharing Strategy
**Approach**: Wrap existing LangChain tools

Our current tools (`kubectl-get.ts`, etc.) use LangChain's `tool()` wrapper. For MCP:

1. Extract the core logic (the async function) into a shared module
2. Keep LangChain wrappers for CLI agent
3. Create MCP wrappers that call the same core logic

```
src/
├── tools/
│   ├── core/              # Shared logic
│   │   ├── kubectl-get.ts
│   │   ├── kubectl-describe.ts
│   │   └── kubectl-logs.ts
│   ├── langchain/         # CLI agent tools
│   │   └── index.ts
│   └── mcp/               # MCP server tools
│       └── index.ts
```

### Output Format
**Decision**: Keep native kubectl output (tables for get, structured text for describe/logs)

**Rationale**:
- Token efficiency research shows plain text is 80% more efficient than JSON
- Tool output flows to LLM context only, not to vector DB (PRD #7 uses controller sync)
- LLMs parse tables well

### Error Response Format
**Pattern**:
```typescript
// On kubectl success
return { content: [{ type: "text", text: stdout }] };

// On kubectl failure
return {
  content: [{ type: "text", text: `kubectl error: ${stderr}` }],
  isError: true
};
```

### MCP Server Entry Point
Create `src/mcp-server.ts` that:
1. Creates McpServer instance
2. Registers kubectl tools
3. Starts stdio transport

Configure in `.mcp.json` for Claude Code integration:
```json
{
  "mcpServers": {
    "cluster-whisperer": {
      "command": "node",
      "args": ["dist/mcp-server.js"]
    }
  }
}
```

---

## Reference Sources

- **MCP Specification**: https://modelcontextprotocol.io/
- **MCP TypeScript SDK**: https://github.com/modelcontextprotocol/typescript-sdk
- **Official MCP Servers**: https://github.com/modelcontextprotocol/servers
- **Viktor's dot-ai**: https://github.com/vfarcic/dot-ai

---

## Next Steps

1. Update PRD #5 with these implementation decisions
2. Proceed to M2: MCP Server Setup
3. Create shared tool core, then MCP wrappers
4. Test with Claude Code as MCP client
