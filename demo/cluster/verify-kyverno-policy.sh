#!/usr/bin/env bash
# ABOUTME: Smoke tests for the cluster-whisperer-resource-allowlist Kyverno ClusterPolicy.
# ABOUTME: Verifies SA-scoped admission control: approved resources pass, unapproved resources are rejected.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

SA_IMPERSONATE="system:serviceaccount:cluster-whisperer:cluster-whisperer-mcp"
POLICY_NAME="cluster-whisperer-resource-allowlist"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

pass() { echo -e "${GREEN}✓ PASS${NC} $1"; }
fail() { echo -e "${RED}✗ FAIL${NC} $1"; FAILURES=$((FAILURES + 1)); }
info() { echo -e "${YELLOW}→${NC} $1"; }

FAILURES=0
NAMESPACE="kyverno-test-$$"

cleanup() {
    # Crossplane reconciles ManagedService objects into Object resources with
    # finalizers. Those finalizers block namespace deletion indefinitely.
    # Strip them first so the namespace can terminate cleanly.
    local stuck_objects
    stuck_objects=$(kubectl get objects.kubernetes.m.crossplane.io \
        -n "${NAMESPACE}" -o name 2>/dev/null || true)
    if [[ -n "${stuck_objects}" ]]; then
        echo "${stuck_objects}" | xargs -I{} kubectl patch {} \
            -n "${NAMESPACE}" --type=merge \
            -p '{"metadata":{"finalizers":[]}}' &>/dev/null || true
    fi
    kubectl delete namespace "${NAMESPACE}" --ignore-not-found &>/dev/null || true
}
trap cleanup EXIT

# ─────────────────────────────────────────────────────────────────────────────
# Pre-flight: verify Kyverno and the policy are present
# ─────────────────────────────────────────────────────────────────────────────

echo ""
echo "=== Kyverno Policy Smoke Tests ==="
echo ""

info "Checking Kyverno pods are running..."
# Use a subshell to isolate pipefail — avoids false failures from grep's exit code
# when kubectl redirects stderr and the pipe is used inside an if condition.
kyverno_pods=$(kubectl get pods -n kyverno 2>/dev/null || true)
if ! echo "${kyverno_pods}" | grep -q "Running"; then
    echo -e "${RED}ERROR${NC}: Kyverno pods not running. Run setup.sh first."
    exit 1
fi
pass "Kyverno pods running"

info "Checking ClusterPolicy exists..."
if ! kubectl get clusterpolicy "${POLICY_NAME}" &>/dev/null; then
    echo -e "${RED}ERROR${NC}: ClusterPolicy '${POLICY_NAME}' not found. Run: kubectl apply -f k8s/kyverno-allowlist.yaml"
    exit 1
fi

POLICY_ACTION=$(kubectl get clusterpolicy "${POLICY_NAME}" -o jsonpath='{.spec.validationFailureAction}' 2>/dev/null)
if [[ "${POLICY_ACTION}" != "Enforce" ]]; then
    fail "Policy validationFailureAction is '${POLICY_ACTION}', expected 'Enforce'"
else
    pass "ClusterPolicy exists with validationFailureAction=Enforce"
fi

# Create an isolated test namespace
kubectl create namespace "${NAMESPACE}" &>/dev/null

# ─────────────────────────────────────────────────────────────────────────────
# Test 1: Non-approved resource is REJECTED when created as cluster-whisperer-mcp SA
# ─────────────────────────────────────────────────────────────────────────────

info "Test 1: ConfigMap creation as cluster-whisperer-mcp SA should be rejected..."

CONFIGMAP_MANIFEST=$(cat <<'EOF'
apiVersion: v1
kind: ConfigMap
metadata:
  name: kyverno-test-rejected
data:
  key: value
EOF
)

REJECT_OUTPUT=$(echo "${CONFIGMAP_MANIFEST}" | kubectl apply -f - \
    -n "${NAMESPACE}" \
    --as="${SA_IMPERSONATE}" 2>&1 || true)

# Accept any rejection: Kyverno denial ("denied the request") or RBAC Forbidden
# ("is forbidden"). The MCP SA has narrow RBAC, so RBAC fires before Kyverno —
# both mechanisms correctly prevent the resource from being created.
if echo "${REJECT_OUTPUT}" | grep -qE "denied the request|is forbidden"; then
    pass "Non-approved resource (ConfigMap) rejected"
else
    fail "Non-approved resource was NOT rejected. Output: ${REJECT_OUTPUT}"
fi

# ─────────────────────────────────────────────────────────────────────────────
# Test 2: ManagedService creation as cluster-whisperer-mcp SA is ALLOWED
# ─────────────────────────────────────────────────────────────────────────────

info "Test 2: ManagedService creation as cluster-whisperer-mcp SA should be allowed..."

MANAGED_SERVICE_MANIFEST=$(cat <<'EOF'
apiVersion: platform.acme.io/v1alpha1
kind: ManagedService
metadata:
  name: kyverno-test-allowed
spec:
  engine: postgresql
  engineVersion: "15"
  storageGB: 20
EOF
)

ALLOW_OUTPUT=$(echo "${MANAGED_SERVICE_MANIFEST}" | kubectl apply -f - \
    -n "${NAMESPACE}" \
    --as="${SA_IMPERSONATE}" 2>&1 || true)

# ManagedService may fail for other reasons (CRD not installed in test namespace, etc.)
# We specifically check it was NOT rejected by Kyverno
if echo "${ALLOW_OUTPUT}" | grep -q "denied the request"; then
    fail "ManagedService was rejected by Kyverno — policy is too broad"
else
    pass "ManagedService creation not blocked by Kyverno"
fi

# ─────────────────────────────────────────────────────────────────────────────
# Test 3: Crossplane SA is UNAFFECTED (policy does not match)
# ─────────────────────────────────────────────────────────────────────────────

info "Test 3: ConfigMap creation as Crossplane SA should NOT be blocked by Kyverno..."

CROSSPLANE_SA="system:serviceaccount:crossplane-system:crossplane"

CROSSPLANE_OUTPUT=$(echo "${CONFIGMAP_MANIFEST}" | kubectl apply -f - \
    -n "${NAMESPACE}" \
    --as="${CROSSPLANE_SA}" 2>&1 || true)

if echo "${CROSSPLANE_OUTPUT}" | grep -q "denied the request"; then
    fail "Crossplane SA was blocked by Kyverno — policy is too broad"
else
    pass "Crossplane SA unaffected by policy"
fi

# ─────────────────────────────────────────────────────────────────────────────
# Test 4: System SA is UNAFFECTED (policy does not match)
# ─────────────────────────────────────────────────────────────────────────────

info "Test 4: ConfigMap creation as default SA should NOT be blocked by Kyverno..."

SYSTEM_SA="system:serviceaccount:default:default"

# Use a distinct resource name so this is a CREATE, not an UPDATE of the Test 3 resource
SYSTEM_CONFIGMAP_MANIFEST=$(cat <<'EOF'
apiVersion: v1
kind: ConfigMap
metadata:
  name: kyverno-test-system-sa
data:
  test: "system-sa-unaffected"
EOF
)

SYSTEM_OUTPUT=$(echo "${SYSTEM_CONFIGMAP_MANIFEST}" | kubectl apply -f - \
    -n "${NAMESPACE}" \
    --as="${SYSTEM_SA}" 2>&1 || true)

if echo "${SYSTEM_OUTPUT}" | grep -q "denied the request"; then
    fail "System SA (default:default) was blocked by Kyverno — policy is too broad"
else
    pass "System SA unaffected by policy"
fi

# ─────────────────────────────────────────────────────────────────────────────
# CLI SA policy tests (cluster-whisperer-cli-resource-allowlist)
# The CLI SA has broad RBAC so Kyverno fires instead of RBAC — the denial
# message should come from Kyverno, not from an RBAC Forbidden.
# ─────────────────────────────────────────────────────────────────────────────

CLI_POLICY_NAME="cluster-whisperer-cli-resource-allowlist"
CLI_SA="system:serviceaccount:cluster-whisperer:cluster-whisperer-cli"

if ! kubectl get clusterpolicy "${CLI_POLICY_NAME}" &>/dev/null; then
    echo -e "${RED}[error]${NC} CLI SA policy '${CLI_POLICY_NAME}' not found — cluster may not have been set up with CLI identity"
    exit 1
else
    info "Test 5: ConfigMap creation as cluster-whisperer-cli SA should be rejected by Kyverno..."
    # Use kubectl create (not apply) to guarantee a CREATE operation — the Kyverno policy
    # only fires on CREATE, and kubectl apply on an existing resource does a PATCH instead.
    CLI_REJECT_OUTPUT=$(kubectl create configmap kyverno-test-cli-rejected \
        --from-literal=test=value \
        -n "${NAMESPACE}" \
        --as="${CLI_SA}" 2>&1 || true)

    if echo "${CLI_REJECT_OUTPUT}" | grep -q "denied the request"; then
        pass "CLI SA: ConfigMap blocked by Kyverno (not RBAC)"
        if echo "${CLI_REJECT_OUTPUT}" | grep -q "cluster-whisperer-cli-resource-allowlist"; then
            pass "CLI SA: Rejection references the CLI policy"
        else
            fail "CLI SA: Rejection did not reference CLI policy. Output: ${CLI_REJECT_OUTPUT}"
        fi
    else
        fail "CLI SA: ConfigMap was NOT blocked. Output: ${CLI_REJECT_OUTPUT}"
    fi

    info "Test 6: ManagedService creation as cluster-whisperer-cli SA should be allowed by Kyverno..."
    cli_allow_exit=0
    CLI_ALLOW_OUTPUT=$(echo "${MANAGED_SERVICE_MANIFEST}" | kubectl apply -f - \
        -n "${NAMESPACE}" \
        --as="${CLI_SA}" 2>&1) || cli_allow_exit=$?

    if echo "${CLI_ALLOW_OUTPUT}" | grep -q "denied the request"; then
        fail "CLI SA: ManagedService was rejected by Kyverno — policy is too broad"
    elif [[ $cli_allow_exit -ne 0 ]]; then
        fail "CLI SA: ManagedService apply failed (non-Kyverno error). Exit: ${cli_allow_exit}. Output: ${CLI_ALLOW_OUTPUT}"
    else
        pass "CLI SA: ManagedService not blocked by Kyverno"
    fi
fi

# ─────────────────────────────────────────────────────────────────────────────
# Summary
# ─────────────────────────────────────────────────────────────────────────────

echo ""
echo "==================================="
if [[ "${FAILURES}" -eq 0 ]]; then
    echo -e "${GREEN}All smoke tests passed${NC}"
else
    echo -e "${RED}${FAILURES} test(s) failed${NC}"
    exit 1
fi
