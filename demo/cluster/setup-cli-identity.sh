#!/usr/bin/env bash
# ABOUTME: Standalone script to set up the cluster-whisperer-cli ServiceAccount identity.
# ABOUTME: Creates SA, applies RBAC, generates kubeconfig, and applies Kyverno policy.
# Run this against a running cluster to test the CLI SA approach before integrating into setup.sh.
# After verification succeeds, the equivalent logic moves into setup.sh (setup_cli_identity function).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
KUBECONFIG_PATH="${HOME}/.kube/config-cluster-whisperer"
CLI_KUBECONFIG_PATH="${HOME}/.kube/config-cluster-whisperer-cli"

export KUBECONFIG="${KUBECONFIG_PATH}"

log_info()    { echo -e "\033[0;34m==>\033[0m $1"; }
log_success() { echo -e "\033[0;32m[ok]\033[0m $1"; }
log_error()   { echo -e "\033[0;31m[error]\033[0m $1"; }

# Verify cluster is accessible before doing anything
if ! kubectl cluster-info &>/dev/null; then
    log_error "Cluster not accessible via ${KUBECONFIG_PATH}"
    log_error "Start the cluster first: ./demo/cluster/setup.sh gcp"
    exit 1
fi

log_info "Setting up cluster-whisperer-cli ServiceAccount identity..."

# Step 1: Create namespace (idempotent) and apply SA + RBAC
log_info "Applying SA and RBAC (k8s/rbac-cli.yaml)..."
kubectl create namespace cluster-whisperer --dry-run=client -o yaml | kubectl apply -f -
kubectl apply -f "${REPO_ROOT}/k8s/rbac-cli.yaml"
log_success "SA and RBAC applied"

# Step 2: Generate a token and write kubeconfig directly.
# GKE caps token duration at 48h regardless of --duration; regenerate before each demo.
log_info "Generating SA token and writing kubeconfig to ${CLI_KUBECONFIG_PATH}..."
TOKEN=$(kubectl create token cluster-whisperer-cli -n cluster-whisperer --duration=8760h)
CLUSTER_SERVER=$(kubectl config view --minify -o jsonpath='{.clusters[0].cluster.server}')
CLUSTER_CA=$(kubectl config view --minify --raw -o jsonpath='{.clusters[0].cluster.certificate-authority-data}')

# Write kubeconfig directly — kubectl config set-cluster does not accept inline CA data.
cat > "${CLI_KUBECONFIG_PATH}" <<EOF
apiVersion: v1
kind: Config
clusters:
- cluster:
    server: ${CLUSTER_SERVER}
    certificate-authority-data: ${CLUSTER_CA}
  name: cluster-whisperer
contexts:
- context:
    cluster: cluster-whisperer
    user: cluster-whisperer-cli
  name: default
current-context: default
users:
- name: cluster-whisperer-cli
  user:
    token: ${TOKEN}
EOF
chmod 600 "${CLI_KUBECONFIG_PATH}"

log_success "Kubeconfig written: ${CLI_KUBECONFIG_PATH}"

# Step 3: Apply Kyverno CLI allowlist policy
log_info "Applying Kyverno CLI allowlist policy (k8s/kyverno-cli-allowlist.yaml)..."
kubectl apply -f "${REPO_ROOT}/k8s/kyverno-cli-allowlist.yaml"

if kubectl get clusterpolicy cluster-whisperer-cli-resource-allowlist &>/dev/null; then
    log_success "Kyverno CLI allowlist policy applied"
else
    log_error "Kyverno CLI allowlist policy not found after apply"
    exit 1
fi

echo ""
log_success "CLI identity setup complete."
echo ""
echo "Verify with:"
echo "  kubectl --kubeconfig ${CLI_KUBECONFIG_PATH} auth whoami"
echo ""
echo "Test Kyverno blocks non-ManagedService (should be denied):"
echo "  kubectl --kubeconfig ${CLI_KUBECONFIG_PATH} create configmap tron-test --from-literal=game=tron"
echo ""
echo "Test ManagedService passes (should succeed):"
echo "  kubectl --kubeconfig ${CLI_KUBECONFIG_PATH} apply -f <path-to-managedservice.yaml>"
echo ""
echo "To use with the demo agent:"
echo "  export CLUSTER_WHISPERER_KUBECONFIG=${CLI_KUBECONFIG_PATH}"
