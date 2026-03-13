#!/usr/bin/env bash
# ABOUTME: Runs kubectl-apply integration tests with ephemeral Kind cluster.
# ABOUTME: Creates cluster, runs tests, tears down cluster — no API tokens needed.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../../.." && pwd)"
CLUSTER_NAME="${KIND_CLUSTER_NAME:-kubectl-apply-test}"

# Track whether we created the cluster (vs reusing existing)
CREATED_CLUSTER=false

cleanup() {
  if [[ "${CREATED_CLUSTER}" == "true" ]]; then
    echo ""
    echo "==> Tearing down cluster..."
    "${SCRIPT_DIR}/teardown.sh"
  fi
}
trap cleanup EXIT

# Step 1: Setup
echo "============================================"
echo "  kubectl-apply Integration Tests"
echo "============================================"
echo ""

if kind get clusters 2>/dev/null | grep -q "^${CLUSTER_NAME}$"; then
  echo "==> Reusing existing cluster: ${CLUSTER_NAME}"
else
  CREATED_CLUSTER=true
fi

"${SCRIPT_DIR}/setup.sh"

# Step 2: Run tests
echo ""
echo "==> Running integration tests..."
cd "${REPO_ROOT}"

KIND_CLUSTER_NAME="${CLUSTER_NAME}" npx vitest run src/tools/core/kubectl-apply.integration.test.ts
TEST_EXIT=$?

# Step 3: Report
echo ""
if [[ ${TEST_EXIT} -eq 0 ]]; then
  echo "==> All integration tests passed"
else
  echo "==> Integration tests FAILED (exit code: ${TEST_EXIT})"
fi

exit ${TEST_EXIT}
