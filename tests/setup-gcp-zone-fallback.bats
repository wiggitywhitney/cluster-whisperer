#!/usr/bin/env bats
# ABOUTME: Tests for GCP zone fallback logic in setup.sh
# ABOUTME: Covers get_gcp_zone_fallbacks and GCE_STOCKOUT retry behavior in create_gke_cluster

SETUP_SH="$BATS_TEST_DIRNAME/../demo/cluster/setup.sh"

setup() {
    TMPDIR=$(mktemp -d)
    MOCK_BIN="$TMPDIR/bin"
    mkdir -p "$MOCK_BIN"
    MOCK_STATE="$TMPDIR/state"
    mkdir -p "$MOCK_STATE"
}

teardown() {
    rm -rf "$TMPDIR"
}

# ---------------------------------------------------------------------------
# get_gcp_zone_fallbacks — pure function, no cluster required
# ---------------------------------------------------------------------------

@test "get_gcp_zone_fallbacks: europe-west1-b returns European fallbacks" {
    run bash -c "source '$SETUP_SH'; get_gcp_zone_fallbacks 'europe-west1-b'"
    [ "$status" -eq 0 ]
    [ "$output" = "europe-west1-c europe-west4-b europe-west2-b" ]
}

@test "get_gcp_zone_fallbacks: us-central1-b returns US Central fallbacks" {
    run bash -c "source '$SETUP_SH'; get_gcp_zone_fallbacks 'us-central1-b'"
    [ "$status" -eq 0 ]
    [ "$output" = "us-central1-c us-central1-f us-east1-b" ]
}

@test "get_gcp_zone_fallbacks: us-east1-b returns US East fallbacks" {
    run bash -c "source '$SETUP_SH'; get_gcp_zone_fallbacks 'us-east1-b'"
    [ "$status" -eq 0 ]
    [ "$output" = "us-east1-c us-east4-b us-central1-b" ]
}

@test "get_gcp_zone_fallbacks: us-west1-b returns US West fallbacks" {
    run bash -c "source '$SETUP_SH'; get_gcp_zone_fallbacks 'us-west1-b'"
    [ "$status" -eq 0 ]
    [ "$output" = "us-west1-c us-west2-b us-central1-b" ]
}

@test "get_gcp_zone_fallbacks: asia-northeast1-b returns Tokyo fallbacks" {
    run bash -c "source '$SETUP_SH'; get_gcp_zone_fallbacks 'asia-northeast1-b'"
    [ "$status" -eq 0 ]
    [ "$output" = "asia-northeast1-c asia-northeast2-b" ]
}

@test "get_gcp_zone_fallbacks: asia-east1-b returns Taiwan fallbacks" {
    run bash -c "source '$SETUP_SH'; get_gcp_zone_fallbacks 'asia-east1-b'"
    [ "$status" -eq 0 ]
    [ "$output" = "asia-east1-c asia-northeast1-b" ]
}

@test "get_gcp_zone_fallbacks: asia-south1-b returns Mumbai fallbacks" {
    run bash -c "source '$SETUP_SH'; get_gcp_zone_fallbacks 'asia-south1-b'"
    [ "$status" -eq 0 ]
    [ "$output" = "asia-south1-c asia-south2-b" ]
}

@test "get_gcp_zone_fallbacks: asia-southeast1-b returns Singapore fallbacks" {
    run bash -c "source '$SETUP_SH'; get_gcp_zone_fallbacks 'asia-southeast1-b'"
    [ "$status" -eq 0 ]
    [ "$output" = "asia-southeast1-c asia-southeast2-b" ]
}

@test "get_gcp_zone_fallbacks: australia-southeast1-b returns Sydney fallbacks" {
    run bash -c "source '$SETUP_SH'; get_gcp_zone_fallbacks 'australia-southeast1-b'"
    [ "$status" -eq 0 ]
    [ "$output" = "australia-southeast1-c australia-southeast2-b" ]
}

@test "get_gcp_zone_fallbacks: southamerica-east1-b returns Sao Paulo fallbacks" {
    run bash -c "source '$SETUP_SH'; get_gcp_zone_fallbacks 'southamerica-east1-b'"
    [ "$status" -eq 0 ]
    [ "$output" = "southamerica-east1-c southamerica-west1-b" ]
}

@test "get_gcp_zone_fallbacks: unknown zone returns empty string" {
    run bash -c "source '$SETUP_SH'; get_gcp_zone_fallbacks 'us-fake-zone-9z'"
    [ "$status" -eq 0 ]
    [ "$output" = "" ]
}

# ---------------------------------------------------------------------------
# detect_gcp_zone — override tracking
# ---------------------------------------------------------------------------

@test "detect_gcp_zone sets GCP_ZONE_IS_OVERRIDE=true when GCP_ZONE env var is set" {
    run bash -c "
        source '$SETUP_SH'
        export GCP_ZONE='europe-west1-b'
        detect_gcp_zone
        echo \"OVERRIDE:\$GCP_ZONE_IS_OVERRIDE\"
    "
    [ "$status" -eq 0 ]
    [[ "$output" == *"OVERRIDE:true"* ]]
}

@test "detect_gcp_zone sets GCP_ZONE_IS_OVERRIDE=false when auto-detecting" {
    # Mock curl to return a predictable geo response so the test doesn't need network
    cat > "$MOCK_BIN/curl" << 'EOF'
#!/usr/bin/env bash
echo '{"country":"US","timezone":"America/Chicago"}'
EOF
    chmod +x "$MOCK_BIN/curl"

    run bash -c "
        export PATH=\"$MOCK_BIN:\$PATH\"
        source '$SETUP_SH'
        detect_gcp_zone
        echo \"OVERRIDE:\$GCP_ZONE_IS_OVERRIDE\"
    "
    [ "$status" -eq 0 ]
    [[ "$output" == *"OVERRIDE:false"* ]]
}

@test "detect_gcp_zone preserves GCP_ZONE value when override is set" {
    run bash -c "
        source '$SETUP_SH'
        export GCP_ZONE='asia-south1-b'
        detect_gcp_zone
        echo \"ZONE:\$GCP_ZONE\"
    "
    [ "$status" -eq 0 ]
    [[ "$output" == *"ZONE:asia-south1-b"* ]]
}

# ---------------------------------------------------------------------------
# create_gke_cluster — GCE_STOCKOUT retry logic
# ---------------------------------------------------------------------------

# Writes a mock gcloud that:
#   - Returns empty for "clusters list" (no existing clusters)
#   - Fails with GCE_STOCKOUT for "clusters create" until call number $succeed_on_call
write_mock_gcloud() {
    local mock_dir="$1"
    local succeed_on_call="${2:-1}"
    local state_dir="$3"

    cat > "$mock_dir/gcloud" << EOF
#!/usr/bin/env bash
subcmd="\$1 \$2 \$3"
case "\$subcmd" in
    "container clusters list")
        exit 0
        ;;
    "container clusters create")
        call_file="$state_dir/create_call_count"
        count=\$(cat "\$call_file" 2>/dev/null || echo 0)
        count=\$((count + 1))
        echo "\$count" > "\$call_file"
        if [[ "\$count" -ge $succeed_on_call ]]; then
            echo "Creating cluster..."
            exit 0
        else
            echo "ERROR: no capacity in zone: GCE_STOCKOUT" >&2
            exit 1
        fi
        ;;
    *)
        echo "mock gcloud: unhandled: \$*" >&2
        exit 1
        ;;
esac
EOF
    chmod +x "$mock_dir/gcloud"
}

# Writes a mock gcloud that always fails with GCE_STOCKOUT
write_mock_gcloud_always_stockout() {
    local mock_dir="$1"
    local state_dir="$2"

    cat > "$mock_dir/gcloud" << EOF
#!/usr/bin/env bash
subcmd="\$1 \$2 \$3"
case "\$subcmd" in
    "container clusters list")
        exit 0
        ;;
    "container clusters create")
        call_file="$state_dir/create_call_count"
        count=\$(cat "\$call_file" 2>/dev/null || echo 0)
        count=\$((count + 1))
        echo "\$count" > "\$call_file"
        echo "ERROR: no capacity in zone: GCE_STOCKOUT" >&2
        exit 1
        ;;
    *)
        echo "mock gcloud: unhandled: \$*" >&2
        exit 1
        ;;
esac
EOF
    chmod +x "$mock_dir/gcloud"
}

# Mock kubectl that always succeeds
write_mock_kubectl() {
    local mock_dir="$1"
    cat > "$mock_dir/kubectl" << 'EOF'
#!/usr/bin/env bash
exit 0
EOF
    chmod +x "$mock_dir/kubectl"
}

# Shell variable overrides for create_gke_cluster tests.
# Sourced AFTER setup.sh to override script-level defaults.
cluster_test_env() {
    echo "
        export GCP_PROJECT='test-project'
        export GKE_MACHINE_TYPE='n2-standard-4'
        export GKE_NUM_NODES=3
        export CLUSTER_NAME='cluster-whisperer-test'
        export CLUSTER_NAME_PREFIX='cluster-whisperer'
    "
}

@test "create_gke_cluster succeeds without retry when primary zone has capacity" {
    write_mock_gcloud "$MOCK_BIN" 1 "$MOCK_STATE"
    write_mock_kubectl "$MOCK_BIN"

    run bash -c "
        export PATH=\"$MOCK_BIN:\$PATH\"
        source '$SETUP_SH'
        $(cluster_test_env)
        export GCP_ZONE='us-central1-b'
        export GCP_ZONE_IS_OVERRIDE=false
        create_gke_cluster
    "
    [ "$status" -eq 0 ]
    [[ "$output" == *"created"* ]]
    [ "$(cat "$MOCK_STATE/create_call_count" 2>/dev/null || echo 0)" -eq 1 ]
}

@test "create_gke_cluster retries in fallback zone on GCE_STOCKOUT" {
    # Primary zone fails with stockout; second call (first fallback) succeeds
    write_mock_gcloud "$MOCK_BIN" 2 "$MOCK_STATE"
    write_mock_kubectl "$MOCK_BIN"

    run bash -c "
        export PATH=\"$MOCK_BIN:\$PATH\"
        source '$SETUP_SH'
        $(cluster_test_env)
        export GCP_ZONE='us-central1-b'
        export GCP_ZONE_IS_OVERRIDE=false
        create_gke_cluster
    "
    [ "$status" -eq 0 ]
    [[ "$output" == *"created"* ]]
    [ "$(cat "$MOCK_STATE/create_call_count")" -eq 2 ]
    # Should mention the fallback zone in output
    [[ "$output" == *"us-central1-c"* ]]
}

@test "create_gke_cluster does not retry when GCP_ZONE is a user override" {
    write_mock_gcloud_always_stockout "$MOCK_BIN" "$MOCK_STATE"
    write_mock_kubectl "$MOCK_BIN"

    run bash -c "
        export PATH=\"$MOCK_BIN:\$PATH\"
        source '$SETUP_SH'
        $(cluster_test_env)
        export GCP_ZONE='us-central1-b'
        export GCP_ZONE_IS_OVERRIDE=true
        create_gke_cluster
    "
    [ "$status" -ne 0 ]
    # Only one create attempt — no fallback
    [ "$(cat "$MOCK_STATE/create_call_count" 2>/dev/null || echo 0)" -eq 1 ]
    [[ "$output" == *"explicitly set"* ]]
}

@test "create_gke_cluster fails listing all attempted zones when fallbacks exhausted" {
    write_mock_gcloud_always_stockout "$MOCK_BIN" "$MOCK_STATE"
    write_mock_kubectl "$MOCK_BIN"

    run bash -c "
        export PATH=\"$MOCK_BIN:\$PATH\"
        source '$SETUP_SH'
        $(cluster_test_env)
        export GCP_ZONE='us-central1-b'
        export GCP_ZONE_IS_OVERRIDE=false
        create_gke_cluster
    "
    [ "$status" -ne 0 ]
    # Error must name the primary zone
    [[ "$output" == *"us-central1-b"* ]]
    # And at least one fallback zone
    [[ "$output" == *"us-central1-c"* ]]
}

@test "create_gke_cluster logs which fallback zone succeeded" {
    # Primary (us-central1-b) stockouts; second call (us-central1-c) succeeds
    write_mock_gcloud "$MOCK_BIN" 2 "$MOCK_STATE"
    write_mock_kubectl "$MOCK_BIN"

    run bash -c "
        export PATH=\"$MOCK_BIN:\$PATH\"
        source '$SETUP_SH'
        $(cluster_test_env)
        export GCP_ZONE='us-central1-b'
        export GCP_ZONE_IS_OVERRIDE=false
        create_gke_cluster
    "
    [ "$status" -eq 0 ]
    # Output must name the fallback zone that succeeded
    [[ "$output" == *"us-central1-c"* ]]
}
