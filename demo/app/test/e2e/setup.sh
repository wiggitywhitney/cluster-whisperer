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

echo "==> Waiting for CrashLoopBackOff (polling up to 120s)..."
for i in $(seq 1 24); do
  POD_STATUS=$(kubectl --context "kind-${CLUSTER_NAME}" get pods -l app=demo-app \
    -o jsonpath='{.items[0].status.containerStatuses[0].state.waiting.reason}' 2>/dev/null || true)
  if [ "$POD_STATUS" = "CrashLoopBackOff" ]; then
    echo "    Pod is in CrashLoopBackOff after $((i * 5))s — demo scenario ready"
    break
  fi
  sleep 5
done

if [ "$POD_STATUS" != "CrashLoopBackOff" ]; then
  echo "    ERROR: Pod never reached CrashLoopBackOff within 120s (got: ${POD_STATUS:-unknown})"
  echo "    Checking pod details..."
  kubectl --context "kind-${CLUSTER_NAME}" get pods -l app=demo-app
  kubectl --context "kind-${CLUSTER_NAME}" logs -l app=demo-app --tail=5 2>/dev/null || true
  exit 1
fi

echo ""
echo "==> Setup complete. Cluster: $CLUSTER_NAME"
echo "    kubectl context: kind-${CLUSTER_NAME}"
