#!/usr/bin/env bash
# ABOUTME: Provisions a Kind cluster with Crossplane and 1,200+ CRDs for the KubeCon demo.
# ABOUTME: Creates a self-contained demo environment with dedicated KUBECONFIG isolation.

# Setup script for cluster-whisperer KubeCon "Choose Your Own Adventure" demo
#
# Creates a Kind cluster with Crossplane providers that register 1,200+ CRDs,
# providing the "overwhelming Kubernetes environment" for the demo narrative.
#
# Usage:
#   ./demo/cluster/setup.sh
#
# The script uses a dedicated KUBECONFIG file (~/.kube/config-cluster-whisperer)
# to avoid polluting the default kubeconfig with Kind entries.

set -euo pipefail

# =============================================================================
# Configuration
# =============================================================================

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

CLUSTER_NAME_PREFIX="cluster-whisperer"
CLUSTER_NAME="${CLUSTER_NAME_PREFIX}-$(date +%Y%m%d-%H%M%S)"
CLUSTER_CONFIG="${SCRIPT_DIR}/kind-config.yaml"
KUBECONFIG_PATH="${HOME}/.kube/config-cluster-whisperer"

# Crossplane version
CROSSPLANE_VERSION="2.2.0"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# =============================================================================
# Helper Functions
# =============================================================================

log_info() {
    echo -e "${BLUE}==>${NC} $1"
}

log_success() {
    echo -e "${GREEN}[ok]${NC} $1"
}

log_warning() {
    echo -e "${YELLOW}[warn]${NC} $1"
}

log_error() {
    echo -e "${RED}[error]${NC} $1"
}

# Wait for pods to exist and become ready.
# Checks for pod existence first — kubectl wait fails immediately if no pods match.
wait_for_pods() {
    local namespace=$1
    local label=$2
    local timeout=${3:-300}

    log_info "Waiting for pods: namespace=${namespace} label=${label} (timeout: ${timeout}s)..."

    local elapsed=0
    local interval=5
    while [[ $elapsed -lt $timeout ]]; do
        if kubectl --kubeconfig "${KUBECONFIG_PATH}" get pods -n "${namespace}" -l "${label}" --no-headers 2>/dev/null | grep -q .; then
            break
        fi
        sleep $interval
        elapsed=$((elapsed + interval))
    done

    if [[ $elapsed -ge $timeout ]]; then
        log_error "No pods with label '${label}' appeared in namespace '${namespace}' within ${timeout}s"
        return 1
    fi

    local remaining=$((timeout - elapsed))
    if kubectl --kubeconfig "${KUBECONFIG_PATH}" wait --for=condition=ready pod \
        -l "${label}" \
        -n "${namespace}" \
        --timeout="${remaining}s" &>/dev/null; then
        log_success "Pods ready: namespace=${namespace} label=${label}"
        return 0
    else
        log_error "Pods did not become ready: namespace=${namespace} label=${label}"
        return 1
    fi
}

# =============================================================================
# Prerequisites Check
# =============================================================================

check_prerequisites() {
    log_info "Checking prerequisites..."

    local missing=()

    command -v kind &>/dev/null || missing+=("kind")
    command -v kubectl &>/dev/null || missing+=("kubectl")
    command -v helm &>/dev/null || missing+=("helm")
    command -v docker &>/dev/null || missing+=("docker")

    if [[ ${#missing[@]} -gt 0 ]]; then
        log_error "Missing required tools: ${missing[*]}"
        exit 1
    fi

    # Verify Docker is running
    if ! docker info &>/dev/null; then
        log_error "Docker is not running"
        exit 1
    fi

    log_success "All prerequisites met"
}

# =============================================================================
# Kind Cluster
# =============================================================================

create_kind_cluster() {
    log_info "Creating Kind cluster '${CLUSTER_NAME}'..."

    # Check if any cluster-whisperer cluster already exists
    local existing
    existing=$(kind get clusters 2>/dev/null | grep "^${CLUSTER_NAME_PREFIX}" || true)
    if [[ -n "${existing}" ]]; then
        log_warning "Existing cluster-whisperer cluster(s) found: ${existing}"
        log_info "Run ./demo/cluster/teardown.sh first, or use a different name"
        exit 1
    fi

    if kind create cluster \
        --name "${CLUSTER_NAME}" \
        --config "${CLUSTER_CONFIG}" \
        --wait 60s; then
        log_success "Kind cluster '${CLUSTER_NAME}' created"
    else
        log_error "Failed to create Kind cluster"
        exit 1
    fi

    # Copy kubeconfig to dedicated file (not symlink, avoids Docker mount issues)
    log_info "Setting up dedicated KUBECONFIG at ${KUBECONFIG_PATH}..."
    kind get kubeconfig --name "${CLUSTER_NAME}" > "${KUBECONFIG_PATH}"
    log_success "KUBECONFIG written to ${KUBECONFIG_PATH}"

    # Verify cluster is accessible via the dedicated kubeconfig
    if kubectl --kubeconfig "${KUBECONFIG_PATH}" cluster-info &>/dev/null; then
        log_success "Cluster is accessible via dedicated KUBECONFIG"
    else
        log_error "Cannot access cluster via ${KUBECONFIG_PATH}"
        exit 1
    fi
}

# =============================================================================
# Crossplane Installation
# =============================================================================

install_crossplane() {
    log_info "Installing Crossplane v${CROSSPLANE_VERSION}..."

    # Add Crossplane Helm repo
    helm repo add crossplane-stable https://charts.crossplane.io/stable --force-update &>/dev/null

    # Check if already installed (idempotency)
    if helm list --kubeconfig "${KUBECONFIG_PATH}" -n crossplane-system 2>/dev/null | grep -q crossplane; then
        log_success "Crossplane already installed"
        return
    fi

    helm install crossplane crossplane-stable/crossplane \
        --kubeconfig "${KUBECONFIG_PATH}" \
        --namespace crossplane-system \
        --create-namespace \
        --version "${CROSSPLANE_VERSION}" \
        --values "${SCRIPT_DIR}/helm-values/crossplane.yaml" \
        --wait --timeout 120s

    log_success "Crossplane v${CROSSPLANE_VERSION} installed"

    # Wait for Crossplane pods to be ready
    wait_for_pods "crossplane-system" "app=crossplane" 120
}

# =============================================================================
# Crossplane Providers
# =============================================================================

install_crossplane_providers() {
    log_info "Installing Crossplane providers in batches (AWS + GCP)..."
    log_info "This registers 1,200+ CRDs. First run pulls ~150 images (slow)."
    log_info "Subsequent runs use cached images and are much faster."

    # Install in batches to avoid overwhelming the Kind cluster.
    # Batch 0 is the family providers (shared dependencies) — must go first.
    local batch_files
    batch_files=$(ls "${SCRIPT_DIR}/manifests/crossplane-providers-batch-"*.yaml 2>/dev/null | sort)

    if [[ -z "${batch_files}" ]]; then
        log_error "No provider batch files found in ${SCRIPT_DIR}/manifests/"
        exit 1
    fi

    local batch_num=0
    local total_batches
    total_batches=$(echo "${batch_files}" | wc -l | tr -d ' ')

    for batch_file in ${batch_files}; do
        local count
        count=$(grep -c 'kind: Provider' "${batch_file}")
        log_info "Batch $((batch_num + 1))/${total_batches}: applying ${count} providers..."

        kubectl --kubeconfig "${KUBECONFIG_PATH}" apply -f "${batch_file}"
        log_success "Batch $((batch_num + 1)) applied (${count} providers)"

        # Give the API server time to settle between batches.
        # Batch 0 (family providers) needs extra time since sub-providers depend on it.
        if [[ $batch_num -eq 0 ]]; then
            log_info "Waiting for family providers to initialize..."
            sleep 30
        elif [[ $batch_num -lt $((total_batches - 1)) ]]; then
            sleep 15
        fi

        batch_num=$((batch_num + 1))
    done

    log_success "All provider batches applied"

    # Wait for CRD registration with progress indicators
    wait_for_crds
}

# Wait for Crossplane provider CRDs to register, showing progress along the way.
# Provider family packages install sub-providers that each register their own CRDs.
# This is the slowest part of setup (5-10 minutes).
wait_for_crds() {
    local target=1200
    local timeout=900  # 15 minutes — 148 sub-providers need time to pull images and register
    local elapsed=0
    local interval=10
    local prev_count=0

    log_info "Waiting for CRD registration (target: ${target}+, timeout: ${timeout}s)..."

    while [[ $elapsed -lt $timeout ]]; do
        local crd_count
        crd_count=$(kubectl --kubeconfig "${KUBECONFIG_PATH}" get crds --no-headers 2>/dev/null | wc -l | tr -d ' ')

        # Show progress when count changes
        if [[ $crd_count -ne $prev_count ]]; then
            local pct=$((crd_count * 100 / target))
            if [[ $pct -gt 100 ]]; then pct=100; fi
            echo -e "  ${BLUE}[${elapsed}s]${NC} CRDs registered: ${crd_count} (${pct}% of target)"
            prev_count=$crd_count
        fi

        if [[ $crd_count -ge $target ]]; then
            log_success "CRD registration complete: ${crd_count} CRDs available"
            return 0
        fi

        sleep $interval
        elapsed=$((elapsed + interval))
    done

    # Didn't hit target but may still have enough CRDs for the demo
    local final_count
    final_count=$(kubectl --kubeconfig "${KUBECONFIG_PATH}" get crds --no-headers 2>/dev/null | wc -l | tr -d ' ')
    if [[ $final_count -ge 500 ]]; then
        log_warning "CRD registration timed out with ${final_count} CRDs (target was ${target}+)"
        log_warning "This may be enough for the demo — check provider status:"
        kubectl --kubeconfig "${KUBECONFIG_PATH}" get providers 2>/dev/null || true
        return 0
    fi

    log_error "CRD registration failed: only ${final_count} CRDs after ${timeout}s"
    log_error "Check provider status:"
    kubectl --kubeconfig "${KUBECONFIG_PATH}" get providers 2>/dev/null || true
    return 1
}

# =============================================================================
# Summary
# =============================================================================

print_summary() {
    local crd_count
    crd_count=$(kubectl --kubeconfig "${KUBECONFIG_PATH}" get crds --no-headers 2>/dev/null | wc -l | tr -d ' ')

    echo ""
    log_success "=============================================="
    log_success "Demo Cluster Ready (M1: Kind + Crossplane)"
    log_success "=============================================="
    echo ""
    log_info "Cluster:    ${CLUSTER_NAME}"
    log_info "KUBECONFIG: ${KUBECONFIG_PATH}"
    log_info "CRDs:       ${crd_count}"
    echo ""
    log_info "To use this cluster:"
    echo "  export KUBECONFIG=${KUBECONFIG_PATH}"
    echo "  kubectl get crds | wc -l"
    echo "  kubectl get providers"
    echo ""
    log_info "To tear down:"
    echo "  ./demo/cluster/teardown.sh"
    echo ""
}

# =============================================================================
# Main
# =============================================================================

main() {
    echo ""
    log_info "Cluster Whisperer Demo Setup"
    log_info "============================"
    echo ""

    check_prerequisites
    create_kind_cluster
    install_crossplane
    install_crossplane_providers
    print_summary
}

main "$@"
