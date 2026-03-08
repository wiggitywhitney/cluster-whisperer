#!/usr/bin/env bash
# ABOUTME: Tears down the Kind cluster created by setup.sh.
# ABOUTME: Cleans up the cluster and removes the kubeconfig context entries.

set -euo pipefail

CLUSTER_NAME="${KIND_CLUSTER_NAME:-demo-app-e2e}"

echo "==> Deleting Kind cluster: $CLUSTER_NAME"
if kind get clusters 2>/dev/null | grep -q "^${CLUSTER_NAME}$"; then
  kind delete cluster --name "$CLUSTER_NAME"
  echo "    Cluster deleted"
else
  echo "    Cluster does not exist, nothing to delete"
fi

# Clean up kubeconfig context entries (Kind merges into ~/.kube/config)
echo "==> Cleaning up kubeconfig entries"
kubectl config delete-context "kind-${CLUSTER_NAME}" 2>/dev/null || true
kubectl config delete-cluster "kind-${CLUSTER_NAME}" 2>/dev/null || true
kubectl config unset "users.kind-${CLUSTER_NAME}" 2>/dev/null || true

echo "==> Teardown complete"
