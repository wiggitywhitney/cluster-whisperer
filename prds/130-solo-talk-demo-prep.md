# PRD #130: Solo Talk Demo Prep — Your Platform's Next Interface Is an Agent

**Status**: Not Started
**Priority**: High (SRE Day Austin: May 11, 2026; KCD Texas: upcoming)
**Created**: 2026-05-06
**GitHub Issue**: wiggitywhitney/cluster-whisperer#130
**Branch**: `feature/prd-130-solo-talk-demo-prep`
**Depends on**: Nothing — all milestones work from current `main`

---

## Problem

The cluster-whisperer demo was built for the two-person KubeCon EU 2026 "Choose Your Own Adventure" talk. Whitney is now giving a solo 25-minute version at SRE Day Austin (May 11) and KCD Texas. The demo needs:

1. Branding updated from "You Choose / Whitney and Viktor" to "Spiders and Rainbows / Whitney"
2. The demo app updated to remove Viktor's YouTube link
3. A new Kyverno policy covering the CLI agent identity (the existing policy only covers the MCP ServiceAccount — the CLI agent uses kubeconfig credentials, which are not blocked today, so the "Tron deploy fails" guardrails moment cannot fire)
4. Quarto/Mermaid slides for the solo talk structure
5. A new demo rehearsal runbook for the solo talk flow

---

## Narrative / Story Context

The through-line of the solo talk is: **"I'd have to put in a ticket."**

Whitney plays two roles simultaneously — **this dual-perspective must be stated explicitly at the start of the talk**, before any demo begins, so the audience understands why she is both the developer hitting blockers and the platform engineer who built the solution:
- **Developer (Spiders and Rainbows team)**: App is broken, has no kubectl access, hits blockers, files tickets
- **Platform engineer**: Built the agent to eliminate those tickets

**The talk opens cold** — no self-introduction, jump straight into "my app is broken." Whitney introduces herself at the END of the talk, not the beginning.

Story beats:
1. Developer's app is broken. No kubectl access → "I'd have to put in a ticket to find out what's wrong"
2. Platform team built a CLI agent. Developer uses it to investigate. Finds the problem (missing database). Can't deploy → "I'd have to put in a ticket"
3. Platform team gives the apply tool (in response to the ticket). Developer's first move: deploy Tron to entertain herself while waiting → Kyverno blocks it ("platform team is helpful but not naive")
4. Developer deploys the real database → app comes alive → spider page with Whitney's YouTube only
5. Observability: Datadog backend shows traces, prompts, failures — platform engineers can see exactly what developers are doing with the agent

The demo uses: LangGraph (default), Qdrant, Datadog.

---

## Milestones

- [x] M1: Branding update — "You Choose" → "Spiders and Rainbows"
- [x] M2: Demo app update — remove Viktor's YouTube link
- [x] M3: Kyverno policy covering CLI agent identity
- [ ] M3.5: setup.sh reliability — Kyverno ordering, cluster status wait, error handling
- [ ] M4: Quarto/Mermaid slides for the solo talk
- [ ] M5: New demo rehearsal runbook

---

## Milestone Details

### M1: Branding update — "You Choose" → "Spiders and Rainbows"

The demo cluster seeds a vector database with Crossplane resources. The resource description that the agent finds in the needle-in-haystack demo currently reads "Whitney and Viktor's You Choose demo app." This must be updated to match the solo talk narrative before the demo can run correctly.

**What to do:**

1. Open `demo/cluster/manifests/xrd.yaml`. Find all references to "You Choose", "YouChoose", "Whitney and Viktor", or "Viktor". Replace with "Spiders and Rainbows" team and "Whitney" as the developer. The XRD description is what gets embedded into the vector DB — it must reference the "Spiders and Rainbows" team so the agent can narrow down to the correct resource during the demo.

2. Search `demo/cluster/setup.sh` for any hardcoded "You Choose" or "Viktor" references (there is at least one comment around line 1165). Update to match the new branding.

3. Verify that the vector DB seed data will reflect the new names on next cluster startup. The controller syncs resources into the vector DB on every reconcile loop — applying the updated XRD to a running cluster should trigger a re-embed automatically. If not, restart the controller pod: `kubectl --kubeconfig ~/.kube/config-cluster-whisperer rollout restart deployment -n cluster-whisperer`. Confirm the vector DB reflects the new description before proceeding to step 4.

4. Run the reset script (`./demo/cluster/reset-demo.sh`) on the running cluster and verify the agent correctly narrows to a "Spiders and Rainbows" ManagedService when asked about databases.

5. **Confirm `setup.sh` fully recreates the correct branding when run from scratch** — new cluster must produce the right vector DB content without manual intervention.

**Success criteria:** When the agent is asked about the developer's database in a fresh demo run, it narrows to a resource whose description references "Spiders and Rainbows" and "Whitney," not "You Choose" or "Viktor."

---

### M2: Demo app update — remove Viktor's YouTube link

The demo app's spider page has two clickable zones: top links to Whitney's YouTube, bottom links to Viktor's YouTube (`@DevOpsToolkit`). For a solo talk this must change.

**What to do:**

1. Open `demo/app/src/server.ts`. The bottom zone (line ~76) links to `https://www.youtube.com/@DevOpsToolkit`. **Ask Whitney what to replace it with before making this change** — options are: the cluster-whisperer GitHub repo URL, `https://whitneylee.com`, or remove the bottom zone entirely so the whole image links to Whitney's YouTube. Do not choose on her behalf. The top zone (Whitney's YouTube `@wiggitywhitney`) stays unchanged.

2. Update the test in `demo/app/src/server.test.ts` if it asserts on the Viktor YouTube URL.

3. Rebuild and push the Docker image:
   ```bash
   docker buildx build --platform linux/amd64 --provenance=false -t wiggitywhitney/demo-app:latest --push demo/app
   ```

4. Verify `demo/cluster/setup.sh` references `wiggitywhitney/demo-app:latest` (or whichever tag is used). If the image tag changed, update setup.sh.

5. On the running cluster, delete the demo-app pod to pull the new image and verify the spider page renders correctly with the updated link.

6. **Confirm `setup.sh` deploys the updated image** — new cluster must serve the updated page without manual steps.

**Success criteria:** The demo app spider page loads with the correct link(s) and no Viktor reference. Tests pass.

---

### M3: Kyverno policy covering CLI agent identity

This is the most technically complex milestone. The guardrails demo moment — where the agent tries to deploy Tron and gets blocked — currently cannot fire because the CLI agent has no dedicated Kubernetes identity and no Kyverno policy scoped to it.

The solution is to give the CLI agent its own ServiceAccount (`cluster-whisperer-cli`), generate a kubeconfig from its token, and scope a Kyverno policy to that SA — mirroring the existing pattern for the MCP server (`cluster-whisperer-mcp` SA + `cluster-whisperer-resource-allowlist` policy). The demo then uses the SA kubeconfig instead of the gcloud kubeconfig, so every `kubectl apply` the agent issues is subject to the allowlist.

**Existing files that must be rewritten (do not use as-is):**

`k8s/kyverno-cli-allowlist.yaml` and `k8s/kyverno-cli-allowlist.test.ts` already exist in the repo but are scoped to the gcloud User identity (`wiggitywhitney@gmail.com`) — an approach that was designed and then rejected. Both must be rewritten as part of this milestone before any testing occurs.

**Open question to resolve before writing code:**

Should the `cluster-whisperer-cli` SA have broad permissions (read everything + create any resource, with Kyverno as the effective guardrail) or narrow permissions (exactly what the agent uses: read for cluster resources, create for ManagedService only)? Decide and record as a new decision before proceeding with step 2.

**What to do:**

1. Write `k8s/rbac-cli.yaml` — ClusterRole + ClusterRoleBinding for `cluster-whisperer-cli` SA in the `cluster-whisperer` namespace. Per Decision 14: broad RBAC — `get`/`list`/`watch`/`create`/`update`/`patch`/`delete` on all resources (`*`) in all API groups (`*`). Narrow RBAC would cause RBAC to fire before Kyverno for non-ManagedService creates, preventing the Kyverno denial message from appearing in the demo.

2. Rewrite `k8s/kyverno-cli-allowlist.yaml` — change the `subjects` block from `kind: User / name: wiggitywhitney@gmail.com` to `kind: ServiceAccount / name: cluster-whisperer-cli / namespace: cluster-whisperer`. Keep the deny conditions (apiVersion + kind check) unchanged.

3. Rewrite `k8s/kyverno-cli-allowlist.test.ts` — update subject assertions: `kind` → `ServiceAccount`, `name` → `cluster-whisperer-cli`, `namespace` → `cluster-whisperer`. Remove the "no namespace on User subject" test; add a test that `namespace` is present and set to `cluster-whisperer`.

4. Create `demo/cluster/setup-cli-identity.sh` — a standalone script (not yet integrated into setup.sh) that:
   - Creates the `cluster-whisperer-cli` SA in `cluster-whisperer` namespace (idempotent)
   - Applies `k8s/rbac-cli.yaml`
   - Generates a token and writes a kubeconfig to `~/.kube/config-cluster-whisperer-cli`:
     ```bash
     TOKEN=$(kubectl --kubeconfig ~/.kube/config-cluster-whisperer create token cluster-whisperer-cli -n cluster-whisperer --duration=8760h)
     CLUSTER_SERVER=$(kubectl --kubeconfig ~/.kube/config-cluster-whisperer config view --minify -o jsonpath='{.clusters[0].cluster.server}')
     CLUSTER_CA=$(kubectl --kubeconfig ~/.kube/config-cluster-whisperer config view --minify --raw -o jsonpath='{.clusters[0].cluster.certificate-authority-data}')
     kubectl config set-cluster cluster-whisperer --server="$CLUSTER_SERVER" --certificate-authority-data="$CLUSTER_CA" --kubeconfig=~/.kube/config-cluster-whisperer-cli
     kubectl config set-credentials cluster-whisperer-cli --token="$TOKEN" --kubeconfig=~/.kube/config-cluster-whisperer-cli
     kubectl config set-context default --cluster=cluster-whisperer --user=cluster-whisperer-cli --kubeconfig=~/.kube/config-cluster-whisperer-cli
     kubectl config use-context default --kubeconfig=~/.kube/config-cluster-whisperer-cli
     ```
   - Applies `k8s/kyverno-cli-allowlist.yaml`

5. Once the cluster is ready (see prerequisite below), run `setup-cli-identity.sh` against the running cluster. Verify:
   - Applying a ConfigMap or Deployment via the SA kubeconfig → Kyverno denies it with the policy message
   - Applying a valid `platform.acme.io/v1alpha1 ManagedService` → passes
   - The existing `cluster-whisperer-resource-allowlist` (MCP SA policy) still works correctly
   - The SA kubeconfig supports the agent's read operations (kubectl_get, kubectl_describe, kubectl_logs)

6. Run the full demo flow (all four acts) with `CLUSTER_WHISPERER_KUBECONFIG=~/.kube/config-cluster-whisperer-cli`. Confirm the Tron deploy moment fires and the real database deploy succeeds.

7. Check whether `demo/cluster/verify-kyverno-policy.sh` needs updating to also smoke-test the CLI SA policy.

8. After verification, integrate into `setup.sh`:
   - Add a `setup_cli_identity()` function (SA creation + RBAC + kubeconfig generation)
   - Update `apply_kyverno_cli_policy()` to also apply `k8s/rbac-cli.yaml`
   - Wire both into `main()` using `run_step` wrappers — setup.sh now uses skip-on-failure pattern (Decision 12): `run_step "setup_cli_identity" setup_cli_identity` and `run_step "apply_kyverno_cli_policy" apply_kyverno_cli_policy`
   - Update `demo/.env` to export `CLUSTER_WHISPERER_KUBECONFIG=~/.kube/config-cluster-whisperer-cli`

9. **Confirm `setup.sh` fully handles CLI identity on a fresh cluster** — new cluster must produce the SA kubeconfig, apply RBAC, and apply both Kyverno policies without manual steps.

**Cluster startup — mandatory prerequisite:**

M3 requires a running GKE cluster. Before running any cluster-dependent steps (step 5 onward), confirm the cluster is ready:

```bash
kubectl --kubeconfig ~/.kube/config-cluster-whisperer cluster-info
```

If that fails, the cluster is still provisioning. Cluster provisioning takes 35–60 minutes and can fail on zone stockout — if it fails, prompt Whitney to retry with a different zone before continuing.

**Success criteria:** Asking the CLI agent to deploy Tron (or any arbitrary resource) produces a Kyverno denial message. Asking it to deploy the platform.acme.io ManagedService succeeds. Both behaviors reproducible on a freshly provisioned cluster.

---

### M3.5: setup.sh reliability — Kyverno ordering, cluster status wait, error handling

Live cluster testing during M3 verification revealed that the GKE control plane enters `RECONCILING` state (API server temporarily unreachable) after Crossplane registers 300+ CRDs. Kyverno installation was consistently hitting this window. This milestone hardens setup.sh against that failure mode and fixes two silent-failure bugs discovered in the same run.

**Five changes, all in `demo/cluster/setup.sh`:**

**Pre-existing changes (NOT part of M3.5 — already committed to this branch):**
- Zone CLI argument: `./demo/cluster/setup.sh gcp us-east1-b` — already works
- Cross-region zone fallbacks (us-central1 → us-east1, us-east4, us-east5, etc.) — already committed
- Partial cluster async-delete after zone failure — already committed

**Change 1 — Reorder: install Kyverno before Crossplane providers (Decision 15)**

Move `install_kyverno`, `apply_kyverno_policies`, `setup_cli_identity`, and `apply_kyverno_cli_policy` to run immediately after `install_crossplane` (controller only) and before `install_crossplane_providers`. The control plane is stable at this point. Kyverno policies reference SAs that don't exist yet — this is safe; Kyverno simply never matches until the SAs are created.

`setup_cli_identity` creates the `cluster-whisperer` namespace idempotently (`kubectl create namespace ... --dry-run=client | kubectl apply -f -`), so it does not depend on `deploy_cluster_whisperer_serve`. It must come after `install_kyverno` so the Kyverno CLI policy (applied by `apply_kyverno_cli_policy` immediately after) can be validated by Kyverno's webhook.

**Change 2 — Cluster status wait (Decision 16)**

Replace `wait_for_api_server` (which blindly retries kubectl until it works) with a new `wait_for_cluster_running` function that polls `gcloud container clusters describe --format="value(status)"` and waits until the cluster returns `RUNNING`. The GKE `status` field (`RUNNING`, `RECONCILING`, `PROVISIONING`) directly indicates whether the control plane is mid-resize.

The function skeleton:
```bash
wait_for_cluster_running() {
    local name="$1" zone="$2"
    local max_wait=600 elapsed=0 interval=15 status
    log_info "Waiting for cluster '${name}' to reach RUNNING state..."
    while [[ $elapsed -lt $max_wait ]]; do
        status=$(gcloud container clusters describe "${name}" \
            --project "${GCP_PROJECT}" --zone "${zone}" \
            --format="value(status)" 2>/dev/null || echo "UNKNOWN")
        [[ "${status}" == "RUNNING" ]] && { log_success "Cluster is RUNNING"; return 0; }
        log_info "  [${elapsed}s] Cluster status: ${status} — waiting..."
        sleep $interval; elapsed=$((elapsed + interval))
    done
    log_error "Cluster did not reach RUNNING state after ${max_wait}s"
    return 1
}
```

Call it in GCP mode after `install_crossplane_providers`: `wait_for_cluster_running "${CLUSTER_NAME}" "${GCP_ZONE}"`.

Keep `wait_for_gke_operations` — it serves a different purpose (waits for explicit GKE operations like node upgrades). Remove `wait_for_api_server` and all its call sites. The existing call after Chroma/Qdrant should become `wait_for_cluster_running`.

**Change 3 — Hard failures for critical steps (Decision 17)**

Remove `install_kyverno`, `apply_kyverno_policies`, `setup_cli_identity`, `apply_kyverno_cli_policy`, and `deploy_cluster_whisperer_serve` from `run_step`. Call them directly in `main()` so any failure aborts setup immediately with a clear error. The skip-on-failure pattern (Decision 12) remains correct for verification steps and optional infrastructure.

**Change 4 — Fix `setup_cli_identity` silent failures (Decision 18)**

The function currently logs `[ok] CLI SA and RBAC applied` and `[ok] CLI SA kubeconfig written` even when kubectl commands fail. Fix by checking exit codes explicitly:
- Namespace creation: `kubectl create namespace ... | kubectl apply -f -` must succeed or the function returns non-zero
- RBAC apply: `kubectl apply -f k8s/rbac-cli.yaml` must succeed or the function returns non-zero
- Token creation: `kubectl create token ...` must succeed; if it fails, do not write the kubeconfig and return non-zero

**Change 5 — Fix `create_ingress_resources` false success (Decision 19)**

The function logs `[ok] Ingress created` unconditionally. Each kubectl apply must be checked; log success only if the ingress was actually created.

**Ordering constraint:** `verify-kyverno-policy.sh` must still run AFTER `deploy_cluster_whisperer_serve` because it impersonates the `cluster-whisperer-mcp` ServiceAccount, which is created by that step. Everything else in the new Kyverno block can move early.

**Task: Agent script review (run before starting the cluster)**

Before triggering a cluster run, the implementing agent must read `demo/cluster/setup.sh` in full and verify the following. Any issues found must be fixed and committed before proceeding to the next task.

- **Ordering in `main()`**: `install_kyverno`, `apply_kyverno_policies`, `setup_cli_identity`, `apply_kyverno_cli_policy` appear BEFORE `install_crossplane_providers`. `deploy_cluster_whisperer_serve` appears AFTER providers and the Chroma/Qdrant/Jaeger/OTel/demo-app installs.
- **No remaining `wait_for_api_server` calls**: search the file — the old function should be gone and all call sites replaced with `wait_for_cluster_running`.
- **`wait_for_cluster_running` placement**: called in GCP mode after `install_crossplane_providers` (and `wait_for_gke_operations`), before `verify_vector_dbs`.
- **`setup_cli_identity` exit code checking**: namespace creation, RBAC apply, and token creation each check `$?` or use `if !` — no unconditional success logs.
- **`create_ingress_resources` exit checking**: each `kubectl apply -f - <<EOF` block is wrapped in `if ! ... ; then return 1; fi`.
- **Hard failures**: `install_kyverno`, `apply_kyverno_policies`, `setup_cli_identity`, `apply_kyverno_cli_policy`, `deploy_cluster_whisperer_serve` are called directly (not via `run_step`).
- **Look for additional improvements**: other functions with unconditional success logs, missing exit-code checks, or silent failure patterns. Fix and commit any found.

**Task: Run the script — HUMAN ACTION REQUIRED (gate before `/prd-update-progress`)**

After the agent script review passes, Whitney must start a fresh cluster run:

```bash
./demo/cluster/setup.sh gcp <zone>
```

Use a zone with available capacity (`us-east1-b` worked in the previous session; if it stockouts, the fallback list will try others automatically).

**This task is complete when Whitney confirms she has started the script** — not when it finishes. The cluster run takes ~1 hour. Do NOT run `/prd-update-progress` until Whitney confirms the script has started. Once she confirms, invoke `/prd-update-progress` — M3.5 can be marked done regardless of whether the run has completed, since the goal of this task is to verify the script launches without immediate errors.

**Success criteria:** `./demo/cluster/setup.sh gcp <zone>` on a fresh cluster completes with Kyverno installed and both policies applied, cluster-whisperer serve running, and the CLI SA kubeconfig containing a valid token. The Kyverno installation step never hits a TLS handshake timeout.

---

### M4: Quarto/Mermaid slides for the solo talk

The talk uses sparse slides — diagrams only, labeled. The demo carries the presentation. Three slide sections are needed, each introduced at the natural break point in the demo flow.

**Format reference:** Follow the style of `/Users/whitney.lee/Documents/Repositories/spinybacked-orbweaver/talk/slides/index.qmd` — Quarto revealjs, Mermaid diagrams built up progressively across slides with `data-transition="none"`, `.big-text .spaced` rainbow text for text slides, speaker notes in `::: {.notes}` blocks.

**Do NOT create a title slide, intro slide, or self-introduction slide.** The talk opens cold with no slides at all — Whitney introduces herself at the end. The slide file contains exactly three sections (A, B, C) and nothing else.

**Work through each section with Whitney one at a time before writing the next.** Do not write all three sections upfront.

**Demo flow reference:** Read `docs/talk/demo-design.md` before writing any slides. It documents the expected agent behavior for all four acts — exact tool calls, log output, what the agent finds at each step, and the Kyverno guardrails moment. Speaker notes must reflect what actually happens in the demo.

**Section A — Agent explainer** (shown AFTER the developer has attempted `kubectl get pods` and it has failed — this is the first slide break point, bridging into the actual CLI agent demo. The talk opens cold with no slides at all):

Build up a Mermaid flowchart progressively showing the agentic loop:
- Start with just: User intent → Agent
- Add: LLM
- Add: Tool loop (LLM ↔ tools, with kubectl_get / kubectl_describe / kubectl_logs as the three tools)
- Add: Response back to user

Include labeled diagram of the three kubectl tools and what each does. Speaker notes should explain: what an agent is, why the tool descriptions matter, what "agentic loop" means in plain language.

**Section B — Vector search** (shown after agent hits the CRD wall):

Build up a Mermaid flowchart showing:
- Kubernetes cluster resources → Controller → Vector DB
- User query → Agent → vector_search tool → Vector DB → semantic match → result
- Why semantic search beats listing 360 CRDs: proximity search on embeddings vs. string matching

Include a brief explainer on embeddings (text → numbers → proximity search). Note: the controller is running in the demo cluster, but its location doesn't matter for the story — what matters is that it keeps the vector DB current. Speaker notes should explain this.

**Section C — Guardrails / Kyverno** (shown while Tron deploy is running):

A simple diagram showing:
- Agent → kubectl apply → Kyverno admission webhook → allow (ManagedService) / deny (everything else)

The framing: "The platform team gave me the apply tool, but they're not naive. Every apply goes through Kyverno." Speaker notes should explain Kyverno admission control in one sentence and what the allowlist policy does.

**There is NO observability slides section.** The observability part of the talk is live only — Whitney opens Datadog and talks over it. Do not add a fourth slide section for observability.

**File:** `docs/talk/slides-your-platform-next-interface.qmd`

**Verify render:** Run `quarto render docs/talk/slides-your-platform-next-interface.qmd` and confirm no errors. Open the output HTML to verify diagrams display correctly at a readable size.

**Success criteria:** All three sections render in Quarto without errors. Diagrams are readable at conference resolution. Speaker notes cover the key talking points for each section. Whitney has reviewed and approved each section before the next is written.

---

### M5: New demo rehearsal runbook

Create a step-by-step runbook for the solo talk demo flow, and rename the existing runbook so both are clearly identified.

**Demo flow reference:** Read `docs/talk/demo-design.md` before writing the runbook. It documents the expected agent behavior for all four acts — exact tool calls, log output, timing details, and what to watch for at each step. The runbook's "Watch for" notes should align with what's documented there.

**What to do:**

1. Rename `docs/talk/demo-rehearsal-runbook.md` → `docs/talk/choose-your-adventure-demo-rehearsal-runbook.md` using `git mv`. Do NOT edit the file's content — only rename it.

2. Create `docs/talk/your-platform-next-interface-demo-rehearsal-runbook.md` with the following sections:

   **Prerequisites**: GKE cluster running, `demo/.env` sourced, reset script run, Kyverno policies verified

   **Step 0 — Clean terminal**: `export PS1='$ '`

   **Step 1 — Source environment**: `source demo/.env`, verify `$CLUSTER_WHISPERER_KUBECONFIG` is set

   **Step 2 — Show no kubectl access**: `kubectl get pods` → connection refused (intentional — developer has no cluster access)

   **Step 3 (slides) — Agent explainer**: Walk through Section A slides

   **Step 4 — Act 1: kubectl investigation**:
   - `agent langgraph` + `tools kubectl`
   - `plz "Something's wrong with my application — can you investigate what's happening and why?"`
   - Watch: kubectl_get → kubectl_describe → kubectl_logs → CrashLoopBackOff, missing database
   - `plz "Do you know what database I should use?"`
   - Watch: agent hits CRD wall, cannot determine correct database

   **Step 5 (slides) — Vector search explainer**: Walk through Section B slides

   **Step 6 — Act 2: add vector search (multi-turn)**:
   - `vectordb qdrant` + `tools kubectl,vector`
   - **This is a continuation of the same conversation thread** — thread memory is active, so the agent already knows about the CrashLoopBackOff and the missing database from Act 1. Do not restart the conversation or clear thread state.
   - Turn 1: `plz "What database should I deploy for my app?"` → agent uses vector_search, finds ~20 results, asks follow-up questions
   - Turn 2: `plz "I'm not sure about most of that. My team is called Spiders and Rainbows. I don't know if it's Postgres or MySQL."` → agent narrows to platform.acme.io ManagedService for the Spiders and Rainbows team
   - Turn 3: `plz "Will you deploy it for me?"` → agent says it cannot (no apply tool) → on stage: "I'd have to put in a ticket"

   **Step 7 — Narrative beat + slides**:
   - `tools kubectl,vector,apply`
   - **This is the story moment where the ticket gets resolved.** Frame it on stage: "So I filed that ticket, and the platform team came back with an updated agent configuration — now I have the apply tool." Then launch the Tron deploy and immediately go to slides while it runs.
   - `plz "Go ahead and deploy a Tron game so I have something to do while I wait for my database ticket"`
   - **Do not wait for the agent response.** Switch to Section C (Kyverno) slides immediately after hitting enter. The Kyverno denial fires quickly — come back to the terminal after the slides to reveal the result.
   - Walk through Section C (Kyverno) slides while the Tron deploy is in flight

   **Step 8 — Come back to Tron result + deploy real database**:
   - Return to terminal — Kyverno has blocked the Tron deploy
   - `plz "Fine. Deploy the database you found for me."` → agent deploys ManagedService, reports SYNCED and READY
   - **Wait ~15 seconds** — Crossplane is provisioning PostgreSQL and creating the db-service in the background. Fill this time by explaining what Crossplane is doing. Do not immediately ask if the app is running — it won't be yet.
   - `plz "Is my app running now? What's the URL?"` → agent returns URL

   **Step 9 — Show the app**: Open URL in browser → spider page

   **Step 10 — Observability**: Open Datadog LLM Observability → show traces, tool calls, prompts, cost

   **Step 11 — Close**: QR code to demo repo or whitneylee.com

   **Troubleshooting**: Carry over relevant entries from the existing runbook (stale thread memory, CrashLoopBackOff backoff, recursion limit)

3. Update any cross-references in other docs if they point to the old runbook filename.

**Success criteria:** Full demo run completes following only the new runbook, without needing to consult other docs. Existing runbook is renamed and unmodified in content.

---

## Decision Log

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Kyverno policy for CLI agent scoped to a dedicated `cluster-whisperer-cli` ServiceAccount (not the gcloud user identity) | Scoping to `wiggitywhitney@gmail.com` (User kind) was initially implemented then rejected: that identity is also used for direct cluster operations (setup, verification, troubleshooting), so the policy would block legitimate kubectl use. Namespace scoping was also considered and rejected: ManagedService XRs are cluster-scoped, so namespace-scoped Kyverno policies don't apply. SA scoping mirrors the existing `cluster-whisperer-mcp` pattern. |
| 2 | Demo uses LangGraph, Qdrant, Datadog — no audience voting | Solo talk; Viktor's audience-choice mechanic doesn't work without a second presenter |
| 3 | Slides are diagrams only — demo carries the talk | Matches Whitney's style; three slide sections at natural demo break points |
| 4 | "Spiders and Rainbows" replaces "You Choose" as the developer team name | Matches Whitney's brand; removes Viktor co-presenter reference |
| 5 | Demo page redesigned: rainbow background + Spider-v1.png foreground, single link to Whitney's YouTube | Spider-v3.png contained Viktor's likeness; the whole page is rebranded with new images from the spider-rainbows repo. No split click zones — the whole image is one CTA. |
| 6 | No slides for the observability section | Observability is shown live in Datadog — opening the real backend is more compelling than a diagram about it |
| 7 | Cold open — no self-introduction at the start; Whitney introduces herself at the end | Drops the audience into the developer's problem immediately; earns the intro rather than leading with credentials |
| 8 | M3 has a mandatory human-in-the-loop pause for cluster startup | Cluster provisioning takes 35–60 minutes and can fail on zone stockout; the implementing agent must prompt Whitney and wait for her confirmation before running any cluster-dependent steps |
| 9 | Test-first workflow for M3: verify the SA approach manually against the running cluster before integrating into setup.sh | A failed integration requires another hour-long cluster spin. A standalone `demo/cluster/setup-cli-identity.sh` script enables full verification before setup.sh is touched. |
| 10 | Demo narrative: the platform team issued the CLI agent a dedicated, constrained identity — the story is about the agent having limited permissions by design, not about runtime identity detection | "We check who you are" is a weaker story than "we gave the agent only what it needs." Aligns with the platform-engineer-as-responsible-party narrative of the talk. |
| 11 | RBAC scope for `cluster-whisperer-cli` SA: **open question — resolve before starting M3 step 1** | Options: (a) broad — read everything + create any resource, relying on Kyverno as the effective guardrail; (b) narrow — exactly the permissions the agent uses (read cluster resources, create for `platform.acme.io` ManagedService only). Record the resolution as a new decision in this log before implementing `k8s/rbac-cli.yaml`. |
| 12 | `setup.sh` adopts skip-on-failure with end-of-run error summary | Individual step failures no longer abort the entire setup. A `run_step` helper wraps each `main()` call; failures are collected in `SETUP_ERRORS` and printed again at the end. Dependent steps cascade-fail informationally rather than silently. Rationale: a partially-set-up cluster is more useful than a half-setup one that blocks M3 progress and requires full teardown + hour-long rebuild. |
| 13 | `create_gke_cluster` resume path implemented (status: committed, **review pending**) | If a cluster-whisperer cluster exists and its kubeconfig is accessible, setup.sh skips creation and continues. Whitney expressed skepticism — keep as complement to skip-on-failure (Decision 12) or revert if the behavior proves confusing. |
| 14 | `cluster-whisperer-cli` SA uses **broad RBAC** (read everything + create/update/patch/delete on all resources); Kyverno is the effective guardrail | Narrow RBAC (only create for platform.acme.io) would cause RBAC to fire before Kyverno for any non-ManagedService create attempt — the Kyverno denial message would never appear, breaking the demo's guardrails moment. Broad RBAC ensures the Tron deploy attempt reaches Kyverno and produces the denial. This directly resolves Decision 11. |
| 15 | Install Kyverno (and apply all Kyverno policies + CLI identity) **before** Crossplane provider installation | Live cluster testing showed the GKE control plane auto-scales (enters RECONCILING state) after Crossplane registers 300+ CRDs, making the API server temporarily unreachable. Kyverno installation requires a stable API server. Installing Kyverno first — while the control plane is still stable — eliminates the timing dependency entirely. The policies are scoped to specific SAs that don't exist yet; this is safe — Kyverno simply never matches until the SAs are created. |
| 16 | Replace `wait_for_api_server` (blind kubectl check) with `gcloud container clusters describe --format="value(status)"` polling for `RUNNING` state | The existing `wait_for_api_server` re-tries kubectl until it succeeds, but gives no visibility into WHY the API is down. GKE exposes a `status` field (`RUNNING`, `RECONCILING`, `PROVISIONING`, etc.) that directly indicates whether the control plane is mid-resize. Waiting for `RUNNING` is deterministic and produces a meaningful log message. Place the wait after Crossplane CRD registration (the primary surge). |
| 17 | Kyverno installation and all dependent steps are **hard failures** — removed from `run_step` | Decision 12 (skip-on-failure) was correct for optional/verification steps, but Kyverno, `apply_kyverno_policies`, `setup_cli_identity`, `apply_kyverno_cli_policy`, and `deploy_cluster_whisperer_serve` are load-bearing for the demo. Silently skipping them (as happened in the failed cluster run) leaves the cluster in an unusable state with no clear indication. These must be hard failures. |
| 18 | Fix `setup_cli_identity` silent failures — add exit code checking for namespace creation, RBAC apply, and token creation | Live cluster run showed `setup_cli_identity` logs `[ok] CLI SA and RBAC applied` and `[ok] CLI SA kubeconfig written` even when all three kubectl commands failed (API down). The kubeconfig was written with an empty token. Functions must check exit codes and fail explicitly rather than logging success unconditionally. |
| 19 | Fix `create_ingress_resources` false success logging — the cluster-whisperer ingress failed with `NotFound` but the function logged `[ok] Ingress created` | Same root issue as Decision 18: the function logs success without verifying the kubectl result. Each ingress creation should check the exit code and only log success if the resource was actually created. |

---

## Design Notes

- Every milestone that modifies cluster resources must end by verifying `setup.sh` reflects the change — the cluster must be fully recreatable from scratch. Check `teardown.sh` only if the change affects what teardown needs to clean up.
- **Do NOT run `teardown.sh` without explicit human approval** — it deletes ALL clusters (Kind and GKE indiscriminately). Use `gcloud container clusters delete` or `kind delete cluster` directly when scoped deletion is needed.
- M3 (Kyverno CLI policy) requires a running GKE cluster. Do not start it until `kubectl --kubeconfig ~/.kube/config-cluster-whisperer cluster-info` succeeds
- The existing `demo-rehearsal-runbook.md` must not have its content modified — only renamed via `git mv`
- The demo app uses `Spider-v1.png` and `Rainbow.png` (shipped in M2) at `demo/app/public/` — no changes needed to these image files
- Talk title: "Your Internal Developer Platform's Next Interface Is an AI Agent"
- SRE Day Austin abstract: "Your Internal Developer Platform's Next Interface Is an AI Agent" / "Livin' In the Future: Your Platform's Next Interface Is an AI Agent"
- **Branch**: `feature/prd-130-solo-talk-demo-prep` — M1, M2, M3, M3.5 are complete on this branch.
- **Pre-conference validation required**: Before SRE Day Austin (May 11), run a full teardown + fresh `./demo/cluster/setup.sh gcp` to validate the complete new setup.sh flow end-to-end. The M3.5 changes have only been tested as code — they have not yet been validated against a live cluster provisioned from scratch with the new ordering.
- `teardown.sh` already has `wait_for_cluster_operations()` (commit `9ff4337`) — handles clusters left locked by Ctrl+C during setup. No changes needed to teardown for M3.
- **Cluster creation must be synchronous** — `--async` was tried and rejected: it fires zone creation requests in parallel, leaving dangling partial clusters in every zone attempted before Ctrl+C or failure. GKE creates a cluster object even on stockout, so after any zone failure setup.sh fires an async delete of the partial cluster before moving to the next zone.
- **Cross-region zone fallbacks are already expanded** — `get_gcp_zone_fallbacks()` now includes inter-regional fallbacks (e.g. us-central1 → us-east1, us-east4, us-east5, us-south1, us-west1, us-west2). A zone argument can also be passed directly: `./demo/cluster/setup.sh gcp us-east1-b`.
