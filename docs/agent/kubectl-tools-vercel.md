# kubectl Tools Pattern (Vercel AI SDK)

This guide explains how kubectl tools are wrapped for the Vercel AI SDK agent. For the same concepts explained through LangChain, see [kubectl-tools-langgraph.md](./kubectl-tools-langgraph.md).

The core concepts — shell injection prevention, separate tools for permissions, directive descriptions — are identical across both frameworks. This document focuses on the Vercel-specific wrapping.

---

## Shared Core, Framework-Specific Wrappers

The kubectl tools are structured in three layers:

```text
src/tools/
├── core/              # Shared logic — schemas, descriptions, execution
│   ├── kubectl-get.ts
│   ├── kubectl-describe.ts
│   └── kubectl-logs.ts
├── vercel/            # Vercel AI SDK wrappers (this document)
│   └── index.ts
└── langchain/         # LangChain wrappers
    └── index.ts
```

The core layer defines Zod schemas, tool descriptions, and execution functions. Both framework wrappers import from core and add their framework-specific glue. If you switched frameworks, you'd only rewrite the wrappers — the schemas and execution logic stay the same.

---

## What's Different from LangChain?

| Aspect | LangChain | Vercel AI SDK |
|--------|-----------|---------------|
| Wrapper function | `tool()` from `@langchain/core/tools` | `tool()` from `ai` |
| Schema property | `schema` | `inputSchema` |
| Return format | Array of Tool objects | `Record<string, Tool>` object |
| Tool naming | `name` property on each tool | Object keys are the names |
| Framework coupling | Name, description, schema in options object | Description, inputSchema, execute in single object |

### LangChain Style

```typescript
import { tool } from "@langchain/core/tools";

const kubectlGetTool = tool(
  async (input) => { ... },       // execute function first
  {
    name: "kubectl_get",           // name as a property
    description: "...",
    schema: kubectlGetSchema,      // "schema" not "inputSchema"
  }
);

// Returns: Tool object (collected into arrays)
return [kubectlGetTool, kubectlDescribeTool, kubectlLogsTool];
```

### Vercel AI SDK Style

```typescript
import { tool } from "ai";

return {
  kubectl_get: tool({              // name is the object key
    description: "...",
    inputSchema: kubectlGetSchema, // "inputSchema" not "schema"
    execute: async (input) => { ... },
  }),
};

// Returns: Record<string, Tool> (merged via object spread)
```

The Vercel SDK uses a single options object where the execute function lives alongside the schema and description. LangChain takes the execute function as the first argument, separate from the options.

---

## Factory Functions

Tools are created via factory functions, not static exports:

```typescript
export function createKubectlTools(options?: KubectlOptions) {
  return {
    kubectl_get: tool({
      description: kubectlGetDescription,
      inputSchema: kubectlGetSchema,
      execute: withToolTracing(
        { name: "kubectl_get", description: kubectlGetDescription },
        async (input: KubectlGetInput) => {
          const { output } = await kubectlGet(input, options);
          return truncateToolResult(output);
        }
      ),
    }),
    // ... kubectl_describe, kubectl_logs
  };
}
```

**Why factories?** The `kubeconfig` option needs to be captured at tool creation time. When `CLUSTER_WHISPERER_KUBECONFIG` is set, every kubectl call needs `--kubeconfig` prepended. The factory captures this path in a closure so individual tool invocations don't need to know about it.

**Why `truncateToolResult()`?** kubectl describe on Crossplane CRDs can return 100K+ characters (full OpenAPI schemas, base64 certificates). Without truncation, a few large tool results can exceed the model's 200K context window. The truncation keeps the head and tail of the output (preserving metadata at the top and Events at the bottom) while trimming the verbose middle.

---

## Tool Merging

The Vercel agent builds its tool set by merging multiple factory returns:

```typescript
private buildTools(toolGroups: ToolGroup[]): ToolSet {
  let tools: ToolSet = {};

  if (toolGroups.includes("kubectl")) {
    tools = { ...tools, ...createKubectlTools(kubectlOpts) };
  }

  if (toolGroups.includes("vector")) {
    tools = { ...tools, ...createVectorTools(vectorStore) };
  }

  if (toolGroups.includes("apply")) {
    tools = { ...tools, ...createApplyTools(vectorStore, kubectlOpts) };
  }

  return tools;
}
```

This is where the `Record<string, Tool>` format pays off — object spread makes tool composition simple. LangChain uses array concatenation (`[...kubectlTools, ...vectorTools]`) for the same effect.

The `toolGroups` mechanism lets the CLI add or remove capabilities at runtime. During the demo, the presenter starts with just `kubectl` tools, then adds `vector` search, then adds `apply` — progressively giving the agent more power.

---

## OpenTelemetry Tracing

Every tool is wrapped with `withToolTracing()`:

```typescript
execute: withToolTracing(
  { name: "kubectl_get", description: kubectlGetDescription },
  async (input) => { ... }
),
```

This creates OTel spans with identical names and attributes regardless of which agent framework calls them. The Vercel SDK also creates its own `ai.toolCall` spans — both coexist intentionally:

- **Our spans** (`kubectl_get.tool`): carry `gen_ai.tool.*` attributes from the shared telemetry contract
- **SDK spans** (`cluster-whisperer-investigate`): carry `ai.toolCall.*` attributes from the Vercel SDK

This dual-span approach means traces are rich whether you're looking at them from the application's perspective or the SDK's.

---

## Graceful Degradation

Vector and apply tools wrap their handlers with connection error handling:

```typescript
function withGracefulDegradation<T>(
  handler: (input: T) => Promise<string>
): (input: T) => Promise<string> {
  return async (input: T): Promise<string> => {
    try {
      await ensureInitialized();
      return await handler(input);
    } catch (error) {
      if (isConnectionError(error)) {
        return "Vector database is not available. Use kubectl tools instead.";
      }
      throw error;
    }
  };
}
```

When the vector database is unreachable, the tool returns a helpful message instead of crashing the agent. The agent can then fall back to kubectl tools for investigation. This matters for the demo — if Chroma or Qdrant isn't running, the agent degrades gracefully instead of erroring out.

---

## For More on Core Concepts

The tool design principles are framework-agnostic:

- **Shell injection prevention** (why `spawnSync` with args array, not `execSync` with string): see [kubectl-tools-langgraph.md](./kubectl-tools-langgraph.md#executing-kubectl)
- **Separate tools for permissions** (why not one "run any kubectl command" tool): see [kubectl-tools-langgraph.md](./kubectl-tools-langgraph.md#why-separate-tools)
- **Directive descriptions** (how tool descriptions guide the investigation flow): see [kubectl-tools-langgraph.md](./kubectl-tools-langgraph.md#directive-descriptions)
