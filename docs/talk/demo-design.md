# Demo App Investigation Flow

This documents the expected agent investigation flow when cluster-whisperer is
asked "Why is my app broken?" against the demo app running without a database.

## Scenario

The demo app (`demo/app/`) is deployed to a Kubernetes cluster with `DATABASE_URL`
pointing to `postgres://db-service:5432/myapp` — a service that doesn't exist. The app
crashes immediately on startup, producing **CrashLoopBackOff**.

## Expected Agent Steps

The agent follows the ReAct pattern (Reason → Act → Observe → Repeat):

### Step 1: Broad cluster scan

**Tool**: `kubectl_get` — pods across all namespaces
**Finds**: `demo-app` pod in `CrashLoopBackOff` with multiple restarts

The agent starts broad because the user didn't specify which app. Scanning all
namespaces surfaces the broken pod immediately — it's the only non-Running pod.

### Step 2: Describe the failing pod

**Tool**: `kubectl_describe` — the demo-app pod
**Finds**:
- Container exits with code 1 after ~1 second
- `DATABASE_URL` environment variable set to `postgres://db-service:5432/myapp`
- Liveness probe configured but irrelevant (app crashes before probe runs)
- Restart count incrementing

The describe output gives the agent two key clues: the `DATABASE_URL` env var and
the rapid crash (started → finished in 1 second).

### Step 3: Check application logs

**Tool**: `kubectl_logs` — with `--previous` flag (since the container keeps restarting)
**Finds**:

```text
[demo-app] Starting server...
[demo-app] Connecting to database at postgres://db-service:5432/myapp...
[demo-app] FATAL: Cannot connect to database at postgres://db-service:5432/myapp - getaddrinfo ENOTFOUND db-service
[demo-app] Exiting with code 1
```

This is the smoking gun. The error message was designed to be agent-friendly:
- Single-line format (easy to parse)
- Includes the word "database" and "FATAL"
- Shows the exact connection target (`db-service:5432`)
- Shows the specific failure (`ENOTFOUND` = DNS resolution failed = service doesn't exist)

### Step 4: Verify the database service is missing

**Tool**: `kubectl_get` — services in default namespace
**Finds**: Only `demo-app` and `kubernetes` services exist. No `db-service`.

This confirms the diagnosis: the app expects a PostgreSQL database at `db-service:5432`,
but no such service exists in the cluster.

## Agent Diagnosis

The agent concludes:

> Your app is broken because the database is completely missing from your cluster.
> The `demo-app` is configured to connect to `postgres://db-service:5432/myapp`,
> but no `db-service` exists. The app crashes immediately when it can't connect.

## Why This Works for the Demo

1. **Clear investigation path**: Each step logically follows from the previous one
2. **Visible reasoning**: Extended thinking shows the audience *why* the agent chooses each tool
3. **Agent-friendly errors**: The `[demo-app] FATAL:` log format gives the agent clear signal
4. **Fast diagnosis**: 4-5 tool calls total, completing in under a minute
5. **Natural resolution**: The diagnosis leads directly to "deploy a database" — which is Act 3 of the demo

## Running the Test

```bash
# Set up Kind cluster with demo app in CrashLoopBackOff
demo/app/test/e2e/setup.sh

# Run the agent investigation (requires ANTHROPIC_API_KEY)
vals exec -i -f .vals.yaml -- demo/app/test/e2e/investigate.sh

# Tear down
demo/app/test/e2e/teardown.sh
```
