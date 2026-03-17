#!/usr/bin/env bash
# ABOUTME: Creates an ephemeral Kind cluster for kubectl-apply integration tests.
# ABOUTME: Minimal cluster — no Crossplane, no Chroma, just a working Kubernetes API.

set -euo pipefail

CLUSTER_NAME="${KIND_CLUSTER_NAME:-kubectl-apply-test}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "==> Creating Kind cluster: ${CLUSTER_NAME}"
if kind get clusters 2>/dev/null | grep -q "^${CLUSTER_NAME}$"; then
  echo "    Cluster already exists, reusing"
else
  kind create cluster --name "${CLUSTER_NAME}" --wait 60s
fi

# Verify cluster is accessible
CONTEXT="kind-${CLUSTER_NAME}"
echo "==> Verifying cluster access..."
if kubectl --context "${CONTEXT}" cluster-info --request-timeout=5s &>/dev/null; then
  echo "    Cluster is accessible via context: ${CONTEXT}"
else
  echo "    ERROR: Cannot access cluster"
  exit 1
fi

# Create a test namespace for isolation
echo "==> Creating test namespace: kubectl-apply-test"
kubectl --context "${CONTEXT}" create namespace kubectl-apply-test --dry-run=client -o yaml \
  | kubectl --context "${CONTEXT}" apply -f -

# Install a minimal CRD so integration tests can apply a custom-apiGroup resource.
# kubectl_apply blocks standard k8s types (Deployment, ConfigMap, etc.) —
# tests need a real CRD with a custom apiGroup to exercise the approved path.
echo "==> Installing test CRD: testresources.test.cluster-whisperer.io"
kubectl --context "${CONTEXT}" apply -f - <<'CRD'
apiVersion: apiextensions.k8s.io/v1
kind: CustomResourceDefinition
metadata:
  name: testresources.test.cluster-whisperer.io
spec:
  group: test.cluster-whisperer.io
  versions:
    - name: v1
      served: true
      storage: true
      schema:
        openAPIV3Schema:
          type: object
          properties:
            spec:
              type: object
              x-kubernetes-preserve-unknown-fields: true
  scope: Namespaced
  names:
    plural: testresources
    singular: testresource
    kind: TestResource
CRD

echo ""
echo "==> Setup complete. Cluster: ${CLUSTER_NAME}"
echo "    kubectl context: ${CONTEXT}"
echo "    test namespace: kubectl-apply-test"
