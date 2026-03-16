#!/usr/bin/env bash
# ABOUTME: Resets the demo cluster to pre-demo state between rehearsal runs.
# ABOUTME: Cleans up deployed ManagedService, restarts demo app, and removes thread checkpoints.

# Reset script for between demo runs (or before starting a fresh demo).
#
# What it cleans up:
#   1. Any deployed ManagedService claims (from Act 3b)
#   2. The PostgreSQL deployment/service created by the Composition
#   3. Demo app — restarted so it's back in CrashLoopBackOff
#   4. Thread checkpoint files (conversation memory from Act 3a)
#
# Usage:
#   ./demo/cluster/reset-demo.sh
#
# Requires: demo/.env sourced or CLUSTER_WHISPERER_KUBECONFIG set.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log_info()  { echo -e "${GREEN}[reset]${NC} $*"; }
log_warn()  { echo -e "${YELLOW}[reset]${NC} $*"; }
log_error() { echo -e "${RED}[reset]${NC} $*"; }

# Load demo/.env if present (for CLUSTER_WHISPERER_KUBECONFIG)
if [[ -f "${REPO_ROOT}/demo/.env" ]]; then
    set -a
    source "${REPO_ROOT}/demo/.env"
    set +a
fi

# Resolve kubeconfig — prefer CLUSTER_WHISPERER_KUBECONFIG, fall back to default location
KUBECONFIG_PATH="${CLUSTER_WHISPERER_KUBECONFIG:-${HOME}/.kube/config-cluster-whisperer}"
if [[ ! -f "${KUBECONFIG_PATH}" ]]; then
    log_error "Kubeconfig not found at ${KUBECONFIG_PATH}"
    log_error "Run demo/cluster/setup.sh first, or set CLUSTER_WHISPERER_KUBECONFIG"
    exit 1
fi
export KUBECONFIG="${KUBECONFIG_PATH}"

log_info "Using kubeconfig: ${KUBECONFIG_PATH}"

# ─── Step 1: Delete any deployed ManagedService claims ────────────────────────
log_info "Checking for deployed ManagedService claims..."

# Find all ManagedService CRDs (the platform ones, not Crossplane internals)
managed_services=$(kubectl get managedservices.platform.acme.io --no-headers 2>/dev/null | awk '{print $1}')
if [[ -n "${managed_services}" ]]; then
    for ms in ${managed_services}; do
        log_info "Deleting ManagedService: ${ms}"
        kubectl delete managedservice.platform.acme.io "${ms}" --wait=false
    done
else
    log_info "No ManagedService claims to clean up"
fi

# Also check for decoy ManagedServices that might have been deployed
for crd in $(kubectl get crd -o name 2>/dev/null | grep 'managedservices\.' | grep -v 'platform\.acme\.io'); do
    resource_type=$(echo "${crd}" | sed 's|customresourcedefinition.apiextensions.k8s.io/||')
    instances=$(kubectl get "${resource_type}" --no-headers 2>/dev/null | awk '{print $1}')
    if [[ -n "${instances}" ]]; then
        for inst in ${instances}; do
            log_info "Deleting decoy ManagedService: ${resource_type}/${inst}"
            kubectl delete "${resource_type}" "${inst}" --wait=false
        done
    fi
done

# ─── Step 2: Wait for PostgreSQL resources to be cleaned up ───────────────────
log_info "Waiting for Composition resources to be cleaned up..."

# Give Crossplane a moment to process the deletion
sleep 5

# Check if db-service still exists
if kubectl get svc db-service -n default --no-headers 2>/dev/null | grep -q db-service; then
    log_warn "db-service still exists, waiting for Crossplane cleanup..."
    kubectl wait --for=delete svc/db-service -n default --timeout=30s 2>/dev/null || true
fi

# ─── Step 3: Restart demo app so it's back in CrashLoopBackOff ───────────────
# Scale to 0 then back to 1 instead of rollout restart. This avoids the old
# ReplicaSet's pod lingering while the new crashing pod ramps up (rollout restart
# keeps the old pod running because the new one never becomes Ready).
log_info "Restarting demo app (scale 0 → 1)..."
kubectl scale deployment/demo-app -n default --replicas=0
sleep 5
kubectl scale deployment/demo-app -n default --replicas=1

# Wait for the new pod to start crashing
log_info "Waiting for demo app to enter CrashLoopBackOff..."
sleep 20

pod_status=$(kubectl get pods -n default -l app=demo-app --no-headers 2>/dev/null | grep -v Terminating | awk '{print $3}' | head -1)
if [[ "${pod_status}" == "CrashLoopBackOff" ]] || [[ "${pod_status}" == "Error" ]]; then
    log_info "Demo app is in ${pod_status} — ready for demo"
else
    log_warn "Demo app status: ${pod_status} (expected CrashLoopBackOff — may need more time)"
fi

# ─── Step 4: Clean up thread checkpoint files ─────────────────────────────────
THREADS_DIR="${REPO_ROOT}/data/threads"
if [[ -d "${THREADS_DIR}" ]]; then
    local_count=$(find "${THREADS_DIR}" -name "*.json" | wc -l | tr -d ' ')
    if [[ "${local_count}" -gt 0 ]]; then
        log_info "Removing ${local_count} thread checkpoint file(s) from ${THREADS_DIR}"
        rm -f "${THREADS_DIR}"/*.json
    else
        log_info "No thread checkpoints to clean up"
    fi
else
    log_info "No threads directory — nothing to clean up"
fi

# ─── Summary ──────────────────────────────────────────────────────────────────
echo ""
log_info "Demo reset complete. Cluster is ready for a fresh run."
echo ""
echo "  Next steps:"
echo "    source demo/.env"
echo "    kubectl get pods  # should fail (no KUBECONFIG in your shell)"
echo ""
