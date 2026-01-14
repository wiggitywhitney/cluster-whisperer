# kubectl Tools Pattern

This guide explains how we build tools that let an AI agent run kubectl commands.

---

## What Is a Tool?

A tool is a function that an AI agent can call. When you ask the agent "Why are pods failing?", it decides which tools to use, calls them, and reasons about the results.

The agent doesn't run kubectl directly. Instead, it calls your tools, and your tools run kubectl. This separation gives you control over what the agent can do.

```
User Question → Agent → Tool → kubectl → Cluster
                  ↑       |
                  └───────┘
                 (agent sees result)
```

---

## The Tool Contract

Every tool needs three things:

| Part | Purpose | Example |
|------|---------|---------|
| **Name** | How the agent refers to the tool | `kubectl_get` |
| **Description** | Tells the agent when and how to use it | "List Kubernetes resources..." |
| **Schema** | Defines what parameters the tool accepts | `{ resource: string, namespace?: string }` |

The agent reads the description and schema to decide whether to use the tool and what arguments to pass.

---

## Our Tool: kubectl_get

### Schema

```typescript
const kubectlGetSchema = z.object({
  resource: z
    .string()
    .describe("The type of Kubernetes resource to list (e.g., 'pods', 'deployments')"),
  namespace: z
    .string()
    .optional()
    .describe("The namespace to query. Omit for default, or use 'all' for all namespaces"),
  name: z
    .string()
    .optional()
    .describe("Specific resource name to get. Omit to list all"),
});
```

The `.describe()` calls are documentation for the agent. Good descriptions help the agent know what values to pass.

### Tool Definition

```typescript
export const kubectlGetTool = tool(
  async (input) => {
    const { resource, namespace, name } = input;
    const args: string[] = ["get", resource];

    if (namespace === "all") {
      args.push("-A");
    } else if (namespace) {
      args.push("-n", namespace);
    }

    if (name) {
      args.push(name);
    }

    return executeKubectl(args);
  },
  {
    name: "kubectl_get",
    description: `List Kubernetes resources and their current status...`,
    schema: kubectlGetSchema,
  }
);
```

The description is the agent's only documentation. It needs to know what the tool does, when to use it, and what options are available.

---

## Executing kubectl

The tool calls `executeKubectl()` which runs kubectl as a subprocess.

### What's a subprocess?

When your code needs to run another program (like kubectl), it spawns a "child process." Your code waits for that process to finish, then gets whatever it printed to the terminal.

Node.js provides `execSync` for this. "Exec" means execute a command, "Sync" means wait for it to finish before continuing.

```typescript
import { execSync } from "child_process";

const output = execSync("kubectl get pods", { encoding: "utf-8" });
// output now contains whatever kubectl printed
```

### Our implementation

```typescript
export function executeKubectl(args: string[]): string {
  try {
    const output = execSync(`kubectl ${args.join(" ")}`, {
      encoding: "utf-8",  // Return a string, not raw bytes
      timeout: 30000,     // Give up after 30 seconds
    });
    return output;
  } catch (error) {
    // Return error message instead of throwing
    return `Error: ${errorMessage}`;
  }
}
```

**Why return errors instead of throwing?** The agent sees the error and can reason about it. If a namespace doesn't exist, the agent might try a different one. If we threw an exception, the agent would just fail.

---

## Why Separate Tools?

We create separate tools for each kubectl operation (get, describe, logs) instead of one "run any kubectl command" tool.

| Benefit | Explanation |
|---------|-------------|
| **Permission control** | Give developers read-only tools. Don't give them delete. |
| **Audit logging** | Log which operations were performed. |
| **Better descriptions** | Each tool has focused documentation for the agent. |
| **Approval workflows** | Future: require human approval for dangerous operations. |

---

## What's Next

In M2, we connect this tool to an agentic loop. The agent will receive a question, decide to call `kubectl_get`, see the results, maybe call `kubectl_describe`, and keep going until it has an answer.

The tool pattern stays the same - we just add more tools following this structure.
