# kubectl Tools Pattern

This guide explains how we build tools that let an AI agent run kubectl commands.

---

## What Parts Are Actually LangChain?

Most of this code is plain TypeScript. LangChain is just one function:

```typescript
import { tool } from "@langchain/core/tools";
```

That's it. The `tool()` function wraps your code so an agent can call it.

Everything else is not LangChain:
- **Zod schema** - just Zod, a TypeScript validation library
- **execSync** - Node.js built-in for running shell commands
- **executeKubectl helper** - plain TypeScript function

If you switched to a different agent framework, you'd only change how the tool is wrapped. The schema and kubectl execution would stay the same.

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

## Our Tool: kubectl_describe

### When to Use It

`kubectl_get` shows you what exists. `kubectl_describe` shows you why something isn't working.

The killer feature is the **Events section** at the bottom of describe output. Events show what Kubernetes has been doing with the resource:
- Scheduling decisions ("Successfully assigned pod to node-1")
- Image operations ("Pulling image nginx:latest")
- Container lifecycle ("Started container", "Back-off restarting failed container")
- Probe failures ("Liveness probe failed: connection refused")

When something is broken, Events tell you why from Kubernetes' perspective.

### Schema

```typescript
const kubectlDescribeSchema = z.object({
  resource: z
    .string()
    .describe("The type of Kubernetes resource (e.g., 'pod', 'deployment')"),
  name: z
    .string()
    .describe("The name of the specific resource to describe"),
  namespace: z
    .string()
    .optional()
    .describe("The namespace containing the resource"),
});
```

**Why is `name` required?** You describe ONE resource to see its details. Unlike `kubectl_get` which can list all pods, `kubectl_describe` needs a specific target. This creates a natural investigation flow: use get to find resources, then describe to understand them.

### Tool Definition

```typescript
export const kubectlDescribeTool = tool(
  async (input) => {
    const { resource, name, namespace } = input;
    const args: string[] = ["describe", resource, name];

    if (namespace) {
      args.push("-n", namespace);
    }

    return executeKubectl(args);
  },
  {
    name: "kubectl_describe",
    description: `Get detailed information about a specific Kubernetes resource.

Returns comprehensive details including configuration, status, and events.
The Events section shows WHY from Kubernetes' perspective.

Use kubectl_get first to find resource names, then kubectl_describe for details.`,
    schema: kubectlDescribeSchema,
  }
);
```

---

## Our Tool: kubectl_logs

### When to Use It

`kubectl_describe` shows what Kubernetes is doing. `kubectl_logs` shows what the application is doing.

When a pod is in CrashLoopBackOff, describe tells you "container exited with code 1" - but that's just the symptom. Logs show you the actual error: a stack trace, a configuration error, a missing environment variable.

### The --previous Flag

Here's the critical detail: when a container crashes and restarts, the current container is brand new. Its logs might just show "Starting up..." because it hasn't crashed yet.

The `--previous` flag gets logs from the **previous** container instance - the one that actually crashed. This is essential for debugging CrashLoopBackOff:

```bash
# Current container (might be empty or just starting)
kubectl logs my-pod -n default

# Previous container (the one that crashed - has the error)
kubectl logs my-pod -n default --previous
```

### Schema

```typescript
const kubectlLogsSchema = z.object({
  pod: z
    .string()
    .describe("The pod name to get logs from"),
  namespace: z
    .string()
    .describe("The namespace containing the pod (required for logs)"),
  args: z
    .array(z.string())
    .optional()
    .describe('Optional flags: ["--previous"], ["--tail=50"], ["-c", "container-name"]'),
});
```

**Why is `namespace` required?** Unlike `kubectl_get` which can work without a namespace, logs always need one. Making it required ensures the agent explicitly specifies where to look.

**Why an `args` array?** kubectl logs has many useful flags (`--previous`, `--tail`, `-c`, `--since`). Rather than defining each as a separate parameter, we use a flexible array. The description tells the agent which flags are most useful.

### Tool Definition

```typescript
export const kubectlLogsTool = tool(
  async (input) => {
    const { pod, namespace, args: extraArgs } = input;
    const args: string[] = ["logs", pod, "-n", namespace];

    if (extraArgs && extraArgs.length > 0) {
      args.push(...extraArgs);
    }

    return executeKubectl(args);
  },
  {
    name: "kubectl_logs",
    description: `Get container logs from a pod. Shows the APPLICATION's perspective.

CRITICAL: Use --previous flag for crashed/restarted containers.

Other useful flags:
- --tail=N: Limit to last N lines
- -c <name>: Specify container in multi-container pods`,
    schema: kubectlLogsSchema,
  }
);
```

---

## Directive Descriptions

Notice how the tool descriptions tell the agent **when** to use each tool:

| Tool | Description says... |
|------|---------------------|
| `kubectl_get` | "For detailed information... use kubectl_describe instead" |
| `kubectl_describe` | "Use kubectl_get first to find resource names, then kubectl_describe for details" |
| `kubectl_logs` | "Use --previous flag for crashed/restarted containers" |

This is the **directive description pattern**. Instead of just explaining what a tool does, we guide the agent's decision-making:

```
Regular description:     "Gets detailed information about a resource"
Directive description:   "Gets detailed information about a resource.
                         Use kubectl_get first to find resources,
                         then kubectl_describe for details."
```

The directive version tells the agent:
1. What the tool does
2. When to use it relative to other tools
3. The expected investigation flow

### Why This Matters

Without directive descriptions, the agent might:
- Jump straight to `kubectl_describe` without knowing the pod name
- Use `kubectl_get` repeatedly without diving deeper into problems
- Miss the Events section that explains why things fail

With directive descriptions, tools naturally chain together into an investigation flow:

```
User: "Why is my pod failing?"
    │
    ▼
Agent reads kubectl_get description:
"Find resources that need further investigation.
 For detailed information, use kubectl_describe."
    │
    ▼
kubectl_get pods → sees CrashLoopBackOff
    │
    ▼
Agent reads kubectl_describe description:
"Check Events to understand why something isn't working."
    │
    ▼
kubectl_describe pod → sees "Back-off restarting failed container" in Events
    │
    ▼
Agent reads kubectl_logs description:
"Use --previous flag for crashed/restarted containers."
    │
    ▼
kubectl_logs --previous → sees actual error/stack trace
    │
    ▼
Agent: "Your pod is crashing because of [specific error from logs]."
```

The descriptions create the investigation logic. The system prompt stays minimal.

---

## What's Next

With all three investigation tools complete (`kubectl_get`, `kubectl_describe`, `kubectl_logs`), M5 focuses on demo prep and polish: testing against real clusters, error handling, and README documentation for KubeCon.
