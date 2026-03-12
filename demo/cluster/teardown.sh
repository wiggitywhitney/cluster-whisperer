#!/usr/bin/env bash
# ABOUTME: Destroys Kind and GKE clusters created by setup.sh and cleans up kubeconfig entries.
# ABOUTME: Pattern-matches cluster names with the cluster-whisperer prefix across both providers.

# Teardown script for cluster-whisperer KubeCon demo
#
# Finds and deletes all Kind and GKE clusters matching the cluster-whisperer
# prefix, then surgically removes their entries from the dedicated KUBECONFIG.
#
# Usage:
#   ./demo/cluster/teardown.sh

set -euo pipefail

# =============================================================================
# Configuration
# =============================================================================

CLUSTER_NAME_PREFIX="cluster-whisperer"
KUBECONFIG_PATH="${HOME}/.kube/config-cluster-whisperer"

# GKE configuration
GCP_PROJECT="demoo-ooclock"

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

# Remove context, cluster, and user entries from the dedicated KUBECONFIG.
# If no contexts remain afterward, delete the file entirely.
cleanup_kubeconfig_entries() {
    local context_name=$1

    if [[ ! -f "${KUBECONFIG_PATH}" ]]; then
        return
    fi

    export KUBECONFIG="${KUBECONFIG_PATH}"

    # Remove context, cluster, and user entries (each may or may not exist)
    kubectl config delete-context "${context_name}" &>/dev/null && \
        log_success "Removed kubeconfig context: ${context_name}" || true
    kubectl config delete-cluster "${context_name}" &>/dev/null && \
        log_success "Removed kubeconfig cluster: ${context_name}" || true
    kubectl config delete-user "${context_name}" &>/dev/null && \
        log_success "Removed kubeconfig user: ${context_name}" || true

    # If no contexts remain, delete the file
    local remaining
    remaining=$(kubectl config get-contexts -o name 2>/dev/null | wc -l | tr -d ' ')
    if [[ "${remaining}" -eq 0 ]]; then
        rm -f "${KUBECONFIG_PATH}"
        log_success "No contexts remain — removed ${KUBECONFIG_PATH}"
    fi
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
        # Kind context names follow the pattern: kind-<cluster-name>
        cleanup_kubeconfig_entries "kind-${name}"
    else
        log_error "Failed to delete Kind cluster '${name}'"
    fi
}

find_gke_clusters() {
    if ! command -v gcloud &>/dev/null; then
        return
    fi
    gcloud container clusters list \
        --project "${GCP_PROJECT}" \
        --filter="name~^${CLUSTER_NAME_PREFIX}" \
        --format="value(name,zone)" 2>/dev/null || true
}

delete_gke_cluster() {
    local name=$1
    local zone=$2
    log_info "Deleting GKE cluster '${name}' in ${zone}..."
    log_warning "This will take several minutes. The cluster incurs billing until fully deleted."
    if gcloud container clusters delete "${name}" \
        --project "${GCP_PROJECT}" \
        --zone "${zone}" \
        --quiet; then
        log_success "GKE cluster '${name}' deleted"
        # GKE context names follow the pattern: gke_<project>_<zone>_<cluster-name>
        cleanup_kubeconfig_entries "gke_${GCP_PROJECT}_${zone}_${name}"
    else
        log_error "Failed to delete GKE cluster '${name}'"
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

    local found_any=false

    # --- Kind clusters ---
    local kind_clusters=()
    while IFS= read -r cluster; do
        [[ -n "${cluster}" ]] && kind_clusters+=("${cluster}")
    done < <(find_kind_clusters)

    if [[ ${#kind_clusters[@]} -gt 0 ]]; then
        found_any=true
        log_info "Found Kind clusters:"
        for cluster in "${kind_clusters[@]}"; do
            echo "  - ${cluster}"
        done
        echo ""
        for cluster in "${kind_clusters[@]}"; do
            delete_kind_cluster "${cluster}"
        done
    fi

    # --- GKE clusters ---
    local gke_clusters=()
    while IFS= read -r line; do
        [[ -n "${line}" ]] && gke_clusters+=("${line}")
    done < <(find_gke_clusters)

    if [[ ${#gke_clusters[@]} -gt 0 ]]; then
        found_any=true
        log_info "Found GKE clusters:"
        for entry in "${gke_clusters[@]}"; do
            local name zone
            name=$(echo "${entry}" | awk '{print $1}')
            zone=$(echo "${entry}" | awk '{print $2}')
            echo "  - ${name} (${zone})"
        done
        echo ""
        log_warning "GKE clusters incur billing until deleted. Proceeding with deletion."
        echo ""
        for entry in "${gke_clusters[@]}"; do
            local name zone
            name=$(echo "${entry}" | awk '{print $1}')
            zone=$(echo "${entry}" | awk '{print $2}')
            delete_gke_cluster "${name}" "${zone}"
        done
    fi

    if [[ "${found_any}" == "false" ]]; then
        log_warning "No clusters found matching prefix '${CLUSTER_NAME_PREFIX}'"
    fi

    echo ""
    log_success "Teardown complete!"
}

main "$@"
