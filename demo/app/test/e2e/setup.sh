#!/usr/bin/env bash
# ABOUTME: Sets up a Kind cluster with the demo app deployed in CrashLoopBackOff state.
# ABOUTME: Builds the Docker image, loads it into Kind, and applies Kubernetes manifests.

set -euo pipefail

CLUSTER_NAME="${KIND_CLUSTER_NAME:-demo-app-e2e}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DEMO_APP_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

echo "==> Creating Kind cluster: $CLUSTER_NAME"
if kind get clusters 2>/dev/null | grep -q "^${CLUSTER_NAME}$"; then
  echo "    Cluster already exists, reusing"
else
  kind create cluster --name "$CLUSTER_NAME" --wait 60s
fi

echo "==> Building demo-app Docker image"
docker build -t demo-app:latest "$DEMO_APP_DIR"

echo "==> Loading image into Kind cluster"
kind load docker-image demo-app:latest --name "$CLUSTER_NAME"

echo "==> Applying Kubernetes manifests"
kubectl --context "kind-${CLUSTER_NAME}" apply -f "$DEMO_APP_DIR/k8s/"

echo "==> Waiting for pod to start (and crash)..."
# Wait for the deployment to create a pod, then wait for CrashLoopBackOff
kubectl --context "kind-${CLUSTER_NAME}" wait --for=condition=Available=false \
  deployment/demo-app --timeout=10s 2>/dev/null || true

# Give the pod time to crash and restart a few times
echo "    Waiting 30s for CrashLoopBackOff to establish..."
sleep 30

echo "==> Verifying CrashLoopBackOff state"
POD_STATUS=$(kubectl --context "kind-${CLUSTER_NAME}" get pods -l app=demo-app \
  -o jsonpath='{.items[0].status.containerStatuses[0].state.waiting.reason}' 2>/dev/null || true)
POD_STATUS="${POD_STATUS:-unknown}"

if [ "$POD_STATUS" = "CrashLoopBackOff" ]; then
  echo "    Pod is in CrashLoopBackOff — demo scenario ready"
else
  echo "    ERROR: Pod status: $POD_STATUS (expected CrashLoopBackOff)"
  echo "    Checking pod details..."
  kubectl --context "kind-${CLUSTER_NAME}" get pods -l app=demo-app
  kubectl --context "kind-${CLUSTER_NAME}" logs -l app=demo-app --tail=5 2>/dev/null || true
  exit 1
fi

echo ""
echo "==> Setup complete. Cluster: $CLUSTER_NAME"
echo "    kubectl context: kind-${CLUSTER_NAME}"
