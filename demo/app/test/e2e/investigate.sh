#!/usr/bin/env bash
# ABOUTME: Runs the cluster-whisperer agent against the demo app in CrashLoopBackOff.
# ABOUTME: Verifies the agent diagnoses the missing database as the root cause.

set -euo pipefail

CLUSTER_NAME="${KIND_CLUSTER_NAME:-demo-app-e2e}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
CONTEXT="kind-${CLUSTER_NAME}"

# --- Preflight checks ---

if ! kind get clusters 2>/dev/null | grep -q "^${CLUSTER_NAME}$"; then
  echo "ERROR: Kind cluster '$CLUSTER_NAME' not found. Run setup.sh first."
  exit 1
fi

if [ -z "${ANTHROPIC_API_KEY:-}" ]; then
  echo "ERROR: ANTHROPIC_API_KEY is not set. This test makes real API calls."
  exit 1
fi

# Verify cluster-whisperer is built
if [ ! -f "$PROJECT_ROOT/dist/index.js" ]; then
  echo "==> Building cluster-whisperer..."
  (cd "$PROJECT_ROOT" && npm run build)
fi

# --- Run the agent ---

echo "==> Running cluster-whisperer agent against cluster: $CONTEXT"
echo "    Question: Why is my app broken?"
echo ""

# Export a dedicated kubeconfig for the Kind cluster to avoid context conflicts.
# Other processes (GKE, other clusters) may change the shared ~/.kube/config context
# during the agent run. Using an isolated kubeconfig prevents this.
KUBECONFIG_FILE=$(mktemp)
kind get kubeconfig --name "$CLUSTER_NAME" > "$KUBECONFIG_FILE"
export KUBECONFIG="$KUBECONFIG_FILE"
trap 'rm -f "$OUTPUT_FILE" "$KUBECONFIG_FILE"' EXIT

OUTPUT_FILE=$(mktemp)

# Run the agent and capture output (allow non-zero exit since we check output)
set +e
node "$PROJECT_ROOT/dist/index.js" "Why is my app broken?" 2>&1 | tee "$OUTPUT_FILE"
AGENT_EXIT=$?
set -e

echo ""
echo "==> Agent exited with code: $AGENT_EXIT"

# --- Verify diagnosis ---

echo ""
echo "==> Verifying agent diagnosis..."

PASS=true

# Check 1: Agent used kubectl tools (should appear in output as tool calls)
if grep -qi "kubectl_get\|kubectl_describe\|kubectl_logs" "$OUTPUT_FILE"; then
  echo "    PASS: Agent used kubectl tools to investigate"
else
  echo "    FAIL: Agent did not appear to use kubectl tools"
  PASS=false
fi

# Check 2: Agent mentioned database in its diagnosis
if grep -qi "database\|DATABASE_URL\|db-service\|postgres" "$OUTPUT_FILE"; then
  echo "    PASS: Agent identified database-related issue"
else
  echo "    FAIL: Agent output does not mention database"
  PASS=false
fi

# Check 3: Agent mentioned CrashLoopBackOff or crash/restart behavior
if grep -qi "crash\|CrashLoopBackOff\|restart\|failing\|error" "$OUTPUT_FILE"; then
  echo "    PASS: Agent identified crash/restart behavior"
else
  echo "    FAIL: Agent did not mention crash behavior"
  PASS=false
fi

echo ""
if [ "$PASS" = true ]; then
  echo "==> ALL CHECKS PASSED: Agent successfully diagnosed the missing database"
  exit 0
else
  echo "==> SOME CHECKS FAILED: Review agent output above"
  exit 1
fi
