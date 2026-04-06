#!/usr/bin/env bats
# ABOUTME: Tests for the MCP server ServiceAccount RBAC manifest.
# ABOUTME: Validates manifest structure and live RBAC permissions (requires cluster).

MANIFEST="$BATS_TEST_DIRNAME/../demo/cluster/manifests/mcp-rbac.yaml"
KUBECONFIG="${KUBECONFIG:-$HOME/.kube/config-cluster-whisperer}"
SA="system:serviceaccount:cluster-whisperer:cluster-whisperer-mcp"

# ---------------------------------------------------------------------------
# Manifest structure tests — no cluster required
# ---------------------------------------------------------------------------

@test "manifest file exists" {
    [ -f "$MANIFEST" ]
}

@test "manifest contains ServiceAccount cluster-whisperer-mcp" {
    grep -q "kind: ServiceAccount" "$MANIFEST"
    grep -q "name: cluster-whisperer-mcp" "$MANIFEST"
}

@test "manifest contains ClusterRole cluster-whisperer-mcp" {
    grep -q "kind: ClusterRole" "$MANIFEST"
    grep -q "name: cluster-whisperer-mcp" "$MANIFEST"
}

@test "manifest contains ClusterRoleBinding" {
    grep -q "kind: ClusterRoleBinding" "$MANIFEST"
}

@test "manifest does not modify the cluster-whisperer ClusterRole" {
    # The existing cluster-whisperer ClusterRole is defined in cluster-whisperer-serve.yaml
    # and must not be touched by this file.
    run grep -c "name: cluster-whisperer$" "$MANIFEST"
    [ "$output" -eq 0 ]
}

@test "ClusterRole grants get/list/watch on pods" {
    grep -q "pods" "$MANIFEST"
    grep -q "get" "$MANIFEST"
    grep -q "list" "$MANIFEST"
    grep -q "watch" "$MANIFEST"
}

@test "ClusterRole grants create on platform.acme.io managedservices" {
    grep -q "platform.acme.io" "$MANIFEST"
    grep -q "managedservices" "$MANIFEST"
    grep -q "create" "$MANIFEST"
}

@test "ClusterRole does not grant create on apps resources" {
    # Deployments, StatefulSets etc. are read-only for the MCP ServiceAccount.
    # The role should only grant get/list/watch on apps resources.
    # Verify the apps stanza does not include 'create'.
    run python3 -c "
import sys, re
text = open('$MANIFEST').read()
# Find the apps apiGroup block and check its verbs
apps_block = re.search(r'apiGroups:.*?\[\"apps\"\].*?verbs:.*?\[(.*?)\]', text, re.DOTALL)
if apps_block:
    verbs = apps_block.group(1)
    if 'create' in verbs:
        sys.exit(1)
sys.exit(0)
"
    [ "$status" -eq 0 ]
}

@test "manifest passes kubectl dry-run validation" {
    run kubectl apply --dry-run=client -f "$MANIFEST" \
        --kubeconfig "$KUBECONFIG" 2>&1
    [ "$status" -eq 0 ]
}

# ---------------------------------------------------------------------------
# Live RBAC tests — require cluster with manifest applied
# ---------------------------------------------------------------------------

setup_live() {
    if ! kubectl cluster-info --kubeconfig "$KUBECONFIG" &>/dev/null; then
        skip "no cluster accessible"
    fi
    if ! kubectl get serviceaccount cluster-whisperer-mcp \
            -n cluster-whisperer \
            --kubeconfig "$KUBECONFIG" &>/dev/null; then
        skip "cluster-whisperer-mcp ServiceAccount not yet deployed"
    fi
}

@test "MCP ServiceAccount cannot create Deployments" {
    setup_live
    run kubectl auth can-i create deployments \
        --as="$SA" \
        --kubeconfig "$KUBECONFIG"
    [ "$output" = "no" ]
}

@test "MCP ServiceAccount can get pods" {
    setup_live
    run kubectl auth can-i get pods \
        --as="$SA" \
        --kubeconfig "$KUBECONFIG"
    [ "$output" = "yes" ]
}

@test "MCP ServiceAccount can create platform.acme.io ManagedServices" {
    setup_live
    run kubectl auth can-i create managedservices.platform.acme.io \
        --as="$SA" \
        --kubeconfig "$KUBECONFIG"
    [ "$output" = "yes" ]
}

@test "MCP ServiceAccount cannot create StatefulSets" {
    setup_live
    run kubectl auth can-i create statefulsets \
        --as="$SA" \
        --kubeconfig "$KUBECONFIG"
    [ "$output" = "no" ]
}
