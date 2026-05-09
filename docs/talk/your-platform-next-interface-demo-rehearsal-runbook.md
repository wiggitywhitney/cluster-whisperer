# Demo Rehearsal Runbook — Your Internal Developer Platform's Next Interface Is an AI Agent

Step-by-step commands for running the solo talk demo. Copy-paste each block, observe the output, move to the next step. All four acts are one continuous conversation thread — do not restart the agent between acts.

---

## Prerequisites

Before touching the terminal:

1. **GKE cluster running.** Verify: `kubectl --kubeconfig ~/.kube/config-cluster-whisperer cluster-info`
2. **Kyverno smoke tests passing.** Run after setup: `./demo/cluster/verify-kyverno-policy.sh`
3. **Thread memory cleared.** The reset script does this automatically.
4. **Docker/Colima running.** Setup auto-starts Colima if needed, but verify before a conference run: `colima status`

To provision a fresh cluster:

```bash
./demo/cluster/setup.sh gcp us-east1-b
```

---

## Between runs: reset the cluster

Run this before every rehearsal and before the actual talk:

```bash
./demo/cluster/reset-demo.sh
```

Confirm: demo-app is in CrashLoopBackOff, no ManagedService claims, one thread file removed.

The reset script prints the correct setup sequence — follow it exactly:

```text
source demo/.env       ← first
agent langgraph        ← second
tools kubectl          ← third (AFTER source — source unsets tool vars)
kubectl get pods       ← verify no access
```

**Order matters**: `source demo/.env` unsets `CLUSTER_WHISPERER_TOOLS`. Setting tools before sourcing is silently undone.

---

## Step 0: Clean terminal

```bash
export PS1='$ '
```

---

## Step 1: Source environment and set Act 1 tools

```bash
source demo/.env
agent langgraph
tools kubectl
```

Verify:

```bash
echo $CLUSTER_WHISPERER_KUBECONFIG
```

Expected: `/Users/you/.kube/config-cluster-whisperer-cli`. If empty, re-source.

---

## Step 2: Show no kubectl access

```bash
kubectl get pods
```

Expected: `The connection to the server localhost:8080 was refused`

This is intentional — the developer's shell has no KUBECONFIG. The agent has cluster access via its own identity; the developer does not.

---

## Step 3 (Slides): Section A — Agent explainer

Walk through Section A slides while the audience absorbs the investigation they just watched. Explain the agentic loop: LLM → tool calls → answer.

---

## Step 4: Act 1 — kubectl investigation

```bash
plz "Something's wrong with my application — can you investigate what's happening and why?"
```

**Watch for:** `kubectl_get` (pods, all namespaces) → `kubectl_describe` (demo-app pod) → `kubectl_logs --previous` → `kubectl_get services` → diagnosis: missing `db-service`.

The agent should identify CrashLoopBackOff with ENOTFOUND db-service and conclude the database service doesn't exist.

Then continue the conversation naturally — ask something like "What database should I deploy?" or "What are my options?" The agent will try `kubectl get crd`, hit the wall of 360+ CRDs, and give an overwhelming list of options. This is the CRD wall moment.

The audience should feel the developer's frustration: too many options, no way to narrow it down.

---

## Step 5 (Slides): Section B — Vector search explainer

Walk through Section B slides. Explain why semantic search over embedded descriptions beats listing 360 CRDs by name.

---

## Step 6: Act 2 — Vector search (multi-turn)

Add vector tools — this is the same conversation thread. The agent already knows about the CrashLoopBackOff and the missing database.

```bash
vectordb qdrant
tools kubectl,vector
```

**Turn 1:**

```bash
plz "The platform team tells me you've been given a vector search tool, and you can use that to help me figure out what database I should deploy for my particular app"
```

**Watch for:** Agent asks for your name and team before searching — many resources are team-specific. This is correct behavior.

**Turn 2:** Answer the agent's question:

```bash
plz "My name is Whitney, and I'm on the Spider Rainbows team."
```

**Watch for:** Agent uses `vector_search` with a semantic query on "Whitney Spider Rainbows" → finds `managedservices.platform.acme.io` — "Platform-approved PostgreSQL database for Whitney's Spiders and Rainbows demo application." First result.

**Turn 3:**

```bash
plz "Awesome. Will you deploy it for me?"
```

**Watch for:** Agent says it cannot — no apply tool. This is the "I'd have to put in a ticket" moment.

On stage: *"So I filed that ticket."*

---

## Step 7: Ticket resolved — Tron attempt + Slides C

Add the apply tool:

```bash
tools kubectl,vector,apply
```

On stage: *"The platform team came back and gave me the apply tool."*

```bash
plz "Go ahead and deploy a Tron game so I have something to do while I wait for my database"
```

**Immediately switch to Section C slides** without waiting for the response. The Kyverno block fires quickly — come back to the terminal after the slides.

Walk through Section C slides while Tron is in flight.

---

## Step 8: Tron result + deploy real database

Return to the terminal. Kyverno has blocked the Tron deploy.

**Watch for:** Error message from Kyverno: `Only platform-approved ManagedService resources can be deployed through the cluster whisperer agent.`

```bash
plz "Fine. Deploy the database you found for me."
```

**Watch for:** Agent applies the `managedservices.platform.acme.io` ManagedService. Reports `SYNCED: True, READY: True` within ~30 seconds.

**Wait.** Crossplane is now provisioning PostgreSQL and creating the `db-service` Kubernetes service in the background. Fill this time explaining what Crossplane does. Do not immediately ask if the app is running — the `db-service` won't exist yet.

After ~60-90 seconds:

```bash
plz "Is my app running now? What's the URL?"
```

**Watch for:** Agent checks pods (demo-app now Running), checks ingresses, returns `http://demo-app.<ip>.nip.io`.

If the app is still in CrashLoopBackOff: continue talking, the pod retries automatically. Kubernetes exponential backoff means longer waits after many restarts — use the time to explain Crossplane's provisioning model.

---

## Step 9: Show the app

Open `http://demo-app.<ip>.nip.io` in a browser. Spider page with rainbow background and Whitney's YouTube link.

---

## Step 10: Observability

Open Datadog LLM Observability. No slides — talk directly over the UI.

Show:
- **Trace list**: Each `plz` invocation is a root span. The full demo is visible as a list of traces with INPUT and OUTPUT.
- **Trace detail**: Click into a trace to see the tool call sequence (kubectl_get → kubectl_describe → kubectl_logs), LLM calls, reasoning steps.
- **The Tron attempt**: The Kyverno rejection is visible — platform engineers see what developers tried.
- **Cost and tokens**: Visible per trace.

On stage: *"As the platform engineer, I can see exactly what developers are asking of this tool, what's working, and what's failing — all the way down to the prompt."*

---

## Step 11: Close

QR code to `whitneylee.com` or the cluster-whisperer repo.

Self-introduction if you haven't already (the talk opens cold with no intro).

---

## Troubleshooting

**Agent asks for name/team in Act 1 (before vector tools are added):**
`source demo/.env` was run after `tools kubectl`, which unset the tool vars and defaulted to kubectl+vector. Re-run in the correct order: `source demo/.env` → `agent langgraph` → `tools kubectl`.

**Agent doesn't ask for name/team in Act 2:**
The investigator prompt gates this on vector tools being active. If it skips straight to searching broadly, check that `tools kubectl,vector` was applied before the plz command.

**Agent found "You Choose" or "Viktor" in search results:**
Stale thread memory from a previous run. Run `./demo/cluster/reset-demo.sh` (it clears `data/threads/*.json`) and start over with a fresh source.

**App stays in CrashLoopBackOff after database deploys:**
The CrashLoopBackOff backoff grows exponentially with restarts. Keep talking — Kubernetes will retry. If the wait is too long, you can delete the pod with the admin kubeconfig (not the SA kubeconfig):
```bash
kubectl --kubeconfig ~/.kube/config-cluster-whisperer delete pod -l app=demo-app
```

**Tron deploy didn't get blocked — it succeeded or errored differently:**
Verify the Kyverno CLI SA policy is applied: `./demo/cluster/verify-kyverno-policy.sh`. All six smoke tests must pass, including Test 5 (CLI SA: ConfigMap blocked by Kyverno, not RBAC).

**Agent hits recursion limit:**
Too many tool calls in a single prompt. Split into two prompts with a pause. The 50-step limit is the LangGraph default.

**Vector search returns the wrong database:**
The semantic search may have landed on a decoy. Give the agent more context: team name + "don't know if Postgres or MySQL" helps it narrow. If it still returns a decoy, check the vector DB: `curl http://qdrant.<ip>.nip.io/collections/capabilities` should show 843 points.
