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

- [ ] M1: Branding update — "You Choose" → "Spiders and Rainbows"
- [ ] M2: Demo app update — remove Viktor's YouTube link
- [ ] M3: Kyverno policy covering CLI agent identity
- [ ] M4: Quarto/Mermaid slides for the solo talk
- [ ] M5: New demo rehearsal runbook

---

## Milestone Details

### M1: Branding update — "You Choose" → "Spiders and Rainbows"

The demo cluster seeds a vector database with Crossplane resources. The resource description that the agent finds in the needle-in-haystack demo currently reads "Whitney and Viktor's You Choose demo app." This must be updated to match the solo talk narrative before the demo can run correctly.

**What to do:**

1. Open `demo/cluster/manifests/xrd.yaml`. Find all references to "You Choose", "YouChoose", "Whitney and Viktor", or "Viktor". Replace with "Spiders and Rainbows" team and "Whitney" as the developer. The XRD description is what gets embedded into the vector DB — it must reference the "Spiders and Rainbows" team so the agent can narrow down to the correct resource during the demo.

2. Search `demo/cluster/setup.sh` for any hardcoded "You Choose" or "Viktor" references (there is at least one comment around line 1165). Update to match the new branding.

3. Verify that the vector DB seed data will reflect the new names on next cluster startup. The controller syncs resources into the vector DB automatically — confirm this covers the XRD description text.

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

This is the most technically complex milestone. The guardrails demo moment — where the agent tries to deploy Tron and gets blocked — currently cannot fire because:

- The existing `cluster-whisperer-resource-allowlist` ClusterPolicy is scoped to the `cluster-whisperer-mcp` ServiceAccount via `subjects`.
- The CLI agent runs kubectl using the kubeconfig file, which authenticates as a GKE user identity (not the MCP ServiceAccount).
- Kyverno's `subjects` matching only works on live admission requests where a ServiceAccount identity is present. A kubeconfig user is a different identity entirely.

**What to do:**

1. With the GKE cluster running, determine the identity the CLI agent uses when running kubectl. Run:
   ```bash
   kubectl --kubeconfig ~/.kube/config-cluster-whisperer auth whoami
   ```
   Note the username (e.g., `user@project.iam.gserviceaccount.com` or a GKE node identity). This is the identity to scope the new policy to.

2. Write a new `k8s/kyverno-cli-allowlist.yaml` ClusterPolicy that:
   - Matches CREATE operations from the CLI kubeconfig identity (use the identity found in step 1)
   - Denies any resource that is not `platform.acme.io/v1alpha1` + `ManagedService`
   - Uses `validationFailureAction: Enforce` and `background: false`
   - Has a clear message: something like "Only platform-approved ManagedService resources can be deployed through the cluster whisperer agent."
   - Does NOT affect system SAs, Crossplane providers, or the `cluster-whisperer-mcp` SA (which already has its own policy)

3. Apply the policy to the running cluster and verify:
   - Try applying a ConfigMap or Deployment manifest via the CLI agent — it should be blocked with the Kyverno denial message
   - Try applying a valid `platform.acme.io/v1alpha1 ManagedService` — it should pass
   - The existing `cluster-whisperer-resource-allowlist` policy (MCP SA) still works correctly

4. Add `apply_kyverno_cli_policy()` to `demo/cluster/setup.sh` — called after `apply_kyverno_policies()` — so the policy is applied on every fresh cluster setup.

5. Run the full demo flow through the Tron deploy moment. Confirm: CLI agent attempts `kubectl apply` with a Tron/nginx manifest → Kyverno returns denial → agent reports it cannot deploy.

6. **Confirm `setup.sh` applies both Kyverno policies** — MCP SA policy and CLI identity policy — on fresh cluster creation.

**Note:** This milestone requires a running GKE cluster. If the cluster is not ready, start here only after `kubectl --kubeconfig ~/.kube/config-cluster-whisperer cluster-info` succeeds.

**Success criteria:** Asking the CLI agent to deploy Tron (or any arbitrary resource) produces a Kyverno denial message. Asking it to deploy the platform.acme.io ManagedService succeeds. Both behaviors reproducible on a freshly provisioned cluster.

---

### M4: Quarto/Mermaid slides for the solo talk

The talk uses sparse slides — diagrams only, labeled. The demo carries the presentation. Three slide sections are needed, each introduced at the natural break point in the demo flow.

**Format reference:** Follow the style of `/Users/whitney.lee/Documents/Repositories/spinybacked-orbweaver/talk/slides/index.qmd` — Quarto revealjs, Mermaid diagrams built up progressively across slides with `data-transition="none"`, `.big-text .spaced` rainbow text for text slides, speaker notes in `::: {.notes}` blocks.

**Do NOT create a title slide, intro slide, or self-introduction slide.** The talk opens cold with no slides at all — Whitney introduces herself at the end. The slide file contains exactly three sections (A, B, C) and nothing else.

**Work through each section with Whitney one at a time before writing the next.** Do not write all three sections upfront.

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
| 1 | Kyverno policy scoped to kubeconfig user identity, not broadly to all users | Prevents unintended impact on Crossplane providers and system components |
| 2 | Demo uses LangGraph, Qdrant, Datadog — no audience voting | Solo talk; Viktor's audience-choice mechanic doesn't work without a second presenter |
| 3 | Slides are diagrams only — demo carries the talk | Matches Whitney's style; three slide sections at natural demo break points |
| 4 | "Spiders and Rainbows" replaces "You Choose" as the developer team name | Matches Whitney's brand; removes Viktor co-presenter reference |
| 5 | Spider image unchanged — only the linked URL changes | Spider is already Whitney-branded; only the bottom clickable zone needs updating |
| 6 | No slides for the observability section | Observability is shown live in Datadog — opening the real backend is more compelling than a diagram about it |
| 7 | Cold open — no self-introduction at the start; Whitney introduces herself at the end | Drops the audience into the developer's problem immediately; earns the intro rather than leading with credentials |

---

## Design Notes

- Every milestone that modifies cluster resources must end by verifying `setup.sh` reflects the change — the cluster must be fully recreatable from scratch. Check `teardown.sh` only if the change affects what teardown needs to clean up.
- **Do NOT run `teardown.sh` without explicit human approval** — it deletes ALL clusters (Kind and GKE indiscriminately). Use `gcloud container clusters delete` or `kind delete cluster` directly when scoped deletion is needed.
- M3 (Kyverno CLI policy) requires a running GKE cluster. Do not start it until `kubectl --kubeconfig ~/.kube/config-cluster-whisperer cluster-info` succeeds
- The existing `demo-rehearsal-runbook.md` must not have its content modified — only renamed via `git mv`
- The spider image (`Spider-v3.png`) lives at `demo/cluster/manifests/Spider-v3.png` and `demo/app/public/Spider-v3.png` — no changes needed to the image file itself
- Talk title: "Your Internal Developer Platform's Next Interface Is an AI Agent"
- SRE Day Austin abstract: "Your Internal Developer Platform's Next Interface Is an AI Agent" / "Livin' In the Future: Your Platform's Next Interface Is an AI Agent"
