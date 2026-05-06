# PRD #132: Full bats test suite for setup.sh and teardown.sh

**Status**: Not Started
**Priority**: Medium
**Created**: 2026-05-06
**GitHub Issue**: https://github.com/wiggitywhitney/cluster-whisperer/issues/132

## Problem

`demo/cluster/setup.sh` and `demo/cluster/teardown.sh` have minimal test coverage. The only existing tests cover zone detection (`tests/setup-gcp-zone-fallback.bats`) and RBAC manifests (`tests/mcp-rbac.bats`). The core logic — cluster wait functions, deletion, kubeconfig cleanup, prerequisite checks — has no tests. Regressions like the incompatible-operation teardown failure go undetected until they block real demo work.

## Solution

Write a bats-core test suite for all deterministic, testable functions in both scripts. Mock `gcloud`, `kubectl`, and `kind` at the CLI boundary — never call real binaries. Extend `~/.claude/rules/bats-bash-testing.md` with the GCP/k8s mocking patterns so future contributors can follow the same approach.

## Success Criteria

- `bats tests/` passes cleanly with no failures or stubs
- `wait_for_cluster_operations` behavior is fully covered (skip, single op, multiple ops)
- `delete_gke_cluster` is covered: wait called before delete, error path logged
- teardown.sh cluster discovery functions covered for both Kind and GKE
- setup.sh deterministic functions have expanded coverage beyond existing zone tests
- `~/.claude/rules/bats-bash-testing.md` has a self-contained section on mocking GCP/k8s CLIs

## Milestones

- [ ] **M1: teardown.sh test suite**

  **Step 1 — add BASH_SOURCE guard to `demo/cluster/teardown.sh`**: The script currently calls `main "$@"` unconditionally at the bottom. Add the standard guard so the file can be sourced without running teardown:
  ```bash
  if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
      main "$@"
  fi
  ```

  **Step 2 — write `tests/teardown.bats`**. Source the script at the top of the file:
  ```bash
  SCRIPT="$BATS_TEST_DIRNAME/../demo/cluster/teardown.sh"
  source "$SCRIPT"
  ```
  Set `GCP_PROJECT` inside `setup()`, not in the global scope. Mock `gcloud`, `kubectl`, and `kind` as bash functions in `setup()` and `unset -f` them in `teardown()`.

  Cover these behaviors:
  - `wait_for_cluster_operations`: no running ops → returns immediately without calling `gcloud operations wait`; single running op → calls `gcloud container operations wait` with correct op name; multiple running ops → `wait` called once per op
  - `delete_gke_cluster`: calls `wait_for_cluster_operations` before `gcloud container clusters delete`; logs error when delete fails
  - `find_gke_clusters`: returns cluster name+zone lines for matching clusters; returns empty when no clusters match
  - `find_kind_clusters`: returns cluster names for matching clusters; returns empty when kind is absent
  - `cleanup_kubeconfig_entries`: use a real temp kubeconfig (no mock needed); verify context/cluster/user removed; verify file deleted when no contexts remain
  - CLI SA kubeconfig cleanup (Decision 20 — PRD #130): `main()` now removes `~/.kube/config-cluster-whisperer-cli` after cluster deletion. Test: file exists before teardown → file removed; file absent → no error

  Do NOT write test stubs that pass without asserting real behavior. Do NOT call real `gcloud`, `kubectl`, or `kind` binaries.

- [ ] **M2: setup.sh test suite expansion**

  Create `tests/setup.bats`. Source `demo/cluster/setup.sh` at the top (it already has the BASH_SOURCE guard). Set all required variables (`GCP_PROJECT`, `CLUSTER_NAME`, `GKE_MACHINE_TYPE`, etc.) in `setup()`.

  Cover these functions (not already covered in `tests/setup-gcp-zone-fallback.bats`):
  - `get_gcp_zone_fallbacks`: all 10 known primary zones → correct fallback list; unknown zone → empty string
  - `wait_for_crds`: mock `kubectl get crds` to increment count each call; target reached → success and correct log; timeout with count ≥ `min_acceptable` → warning + success; timeout with count < `min_acceptable` → failure
  - `wait_for_gke_operations`: no running ops → immediate return; ops present → polls until empty
  - `wait_for_api_server`: kubectl succeeds on first call → success; kubectl always fails → failure after timeout
  - `run_step` (Decision 12 — skip-on-failure pattern): step function succeeds → SETUP_ERRORS remains empty, setup continues; step function fails → error added to SETUP_ERRORS, setup continues (does not abort)
  - `create_gke_cluster` resume path (Decision 13): cluster exists + kubeconfig accessible → skip creation, set GCP_ZONE from existing cluster, return; cluster exists + kubeconfig inaccessible → exit 1
  - `wait_for_cluster_running` (Decision 16 — replaces `wait_for_api_server`): mock `gcloud container clusters describe` to return RECONCILING then RUNNING; verify function waits until RUNNING; mock always-RECONCILING → timeout behavior
  - `setup_cli_identity` exit code checking (Decision 18): namespace creation failure → function exits non-zero (not silent success); token creation failure → function exits non-zero; success path → kubeconfig written and function exits 0
  - `create_ingress_resources` per-ingress exit check (Decision 19): ingress creation failure → logged as error, function exits non-zero; success → logs `[ok] Ingress created`
  - Step ordering: verify `install_kyverno` is invoked before `install_crossplane_providers` in main() (Decision 15) — parse main() body and assert ordering
  - `run_helm_step` (Decision 21): step succeeds → SETUP_ERRORS empty; step fails + cluster RUNNING → no retry, error recorded; step fails + cluster RECONCILING → waits for RUNNING, retries; step fails + cluster RECONCILING, retry also fails → error recorded
  - `run_helm_step` idempotency: failing install leaves FAILED release → next call uninstalls and retries (not mistaken for deployed)

  **Do NOT write tests for Kind-mode code paths** (Decision 25 — cluster-whisperer is GKE-only; Kind mode paths are not maintained).

  **Pending**: when the webhook connectivity probe question (Decision 24) is resolved, add tests for that behavior.

  Do NOT modify `tests/setup-gcp-zone-fallback.bats`. Run the full suite after M2 to confirm no regressions.

- [ ] **M3: Extend `~/.claude/rules/bats-bash-testing.md` with GCP/k8s mocking patterns**

  Append a "## Mocking GCP and Kubernetes CLIs" section. It must include:
  1. The pattern for defining a `gcloud` mock that captures args into a variable and returns controlled output
  2. The pattern for mocking `kubectl` for queries that return line counts (CRD count, node count)
  3. How to reset mocks between tests (`unset -f gcloud kubectl kind` in `teardown()`)
  4. The call-count pattern: how to verify a function was called N times (using a counter variable in the mock body)
  5. A minimal, complete working example: one `@test` block that mocks `gcloud container operations list` to return an op name on the first call and empty on the second, then asserts `gcloud container operations wait` was called once

  The section must be self-contained — a contributor should be able to write a new mock without reading the existing tests in this repo.

## Design Notes

- Tests must never call real `gcloud`, `kubectl`, or `kind`. All external CLI tools must be mocked as bash functions within `setup()` or the test body.
- Functions that call `exit 1` on failure cannot be tested directly with `run` without subshell isolation. Test error-path *logging* (check `$output`) rather than exit behavior for these cases.
- `cleanup_kubeconfig_entries` is testable with real temp files — no mock needed.
- The existing `tests/setup-gcp-zone-fallback.bats` must not regress. Run `bats tests/` after each milestone before marking it complete.

## Decision Log

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Test error paths via output assertions, not exit-code trapping | Functions calling `exit 1` require subshell gymnastics that make tests fragile. Asserting the error message in `$output` is more readable and catches the important behavior. |
| 2 | Add BASH_SOURCE guard to teardown.sh before writing any tests | Without it, sourcing teardown.sh runs the script immediately. Fixing the script is the right unblocking step, not working around it in tests. |
| 3 | Global rules in `~/.claude/rules/bats-bash-testing.md`, not project-level | Mocking patterns for GCP/k8s CLIs are reusable across any project that shells out to these tools. |
