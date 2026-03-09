#!/usr/bin/env bash
# ABOUTME: Destroys Kind clusters created by setup.sh and cleans up the dedicated KUBECONFIG.
# ABOUTME: Pattern-matches cluster names with the cluster-whisperer prefix.

# Teardown script for cluster-whisperer KubeCon demo
#
# Finds and deletes all Kind clusters matching the cluster-whisperer prefix,
# then removes the dedicated KUBECONFIG file.
#
# Usage:
#   ./demo/cluster/teardown.sh

set -euo pipefail

# =============================================================================
# Configuration
# =============================================================================

CLUSTER_NAME_PREFIX="cluster-whisperer"
KUBECONFIG_PATH="${HOME}/.kube/config-cluster-whisperer"

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

# =============================================================================
# Find and Delete Clusters
# =============================================================================

find_kind_clusters() {
    if ! command -v kind &>/dev/null; then
        return
    fi
    kind get clusters 2>/dev/null | grep "^${CLUSTER_NAME_PREFIX}" || true
}

delete_kind_cluster() {
    local name=$1
    log_info "Deleting Kind cluster '${name}'..."
    if kind delete cluster --name "${name}"; then
        log_success "Kind cluster '${name}' deleted"
    else
        log_error "Failed to delete Kind cluster '${name}'"
    fi
}

# =============================================================================
# Main
# =============================================================================

main() {
    echo ""
    log_info "Cluster Whisperer Demo Teardown"
    log_info "================================"
    echo ""

    local kind_clusters=()

    while IFS= read -r cluster; do
        [[ -n "${cluster}" ]] && kind_clusters+=("${cluster}")
    done < <(find_kind_clusters)

    if [[ ${#kind_clusters[@]} -eq 0 ]]; then
        log_warning "No clusters found matching prefix '${CLUSTER_NAME_PREFIX}'"
    else
        log_info "Found clusters:"
        for cluster in "${kind_clusters[@]}"; do
            echo "  - Kind: ${cluster}"
        done
        echo ""

        for cluster in "${kind_clusters[@]}"; do
            delete_kind_cluster "${cluster}"
        done
    fi

    # Clean up dedicated KUBECONFIG file
    if [[ -f "${KUBECONFIG_PATH}" ]]; then
        log_info "Removing dedicated KUBECONFIG: ${KUBECONFIG_PATH}"
        rm -f "${KUBECONFIG_PATH}"
        log_success "KUBECONFIG removed"
    else
        log_info "No dedicated KUBECONFIG file found at ${KUBECONFIG_PATH}"
    fi

    echo ""
    log_success "Teardown complete!"
}

main "$@"
