#!/usr/bin/env bash
# ABOUTME: Provisions a Kind or GKE cluster with Crossplane and CRDs for the KubeCon demo.
# ABOUTME: Accepts mode argument (kind/gcp) for local iteration or full rehearsal environments.

# Setup script for cluster-whisperer KubeCon "Choose Your Own Adventure" demo
#
# Creates a Kubernetes cluster with Crossplane providers that register CRDs,
# providing the "overwhelming Kubernetes environment" for the demo narrative.
#
# Usage:
#   ./demo/cluster/setup.sh kind   # Local Kind cluster (~360 CRDs)
#   ./demo/cluster/setup.sh gcp    # GKE cluster (~360 CRDs)
#
# The script uses a dedicated KUBECONFIG file (~/.kube/config-cluster-whisperer).
# Credentials are merged into this file (not overwritten), so multiple clusters
# can coexist. KUBECONFIG is exported early so all kubectl/helm commands use it
# automatically.

set -euo pipefail

# =============================================================================
# Configuration
# =============================================================================

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

# Load .env if present (for API keys: ANTHROPIC_API_KEY, VOYAGE_API_KEY, DD_API_KEY)
if [[ -f "${REPO_ROOT}/.env" ]]; then
    set -a
    source "${REPO_ROOT}/.env"
    set +a
fi

CLUSTER_NAME_PREFIX="cluster-whisperer"
CLUSTER_NAME="${CLUSTER_NAME_PREFIX}-$(date +%Y%m%d-%H%M%S)"
CLUSTER_CONFIG="${SCRIPT_DIR}/kind-config.yaml"
KUBECONFIG_PATH="${HOME}/.kube/config-cluster-whisperer"

# Ingress NGINX Controller version (kubernetes/ingress-nginx, Kind-specific manifest)
INGRESS_NGINX_VERSION="v1.12.1"

# Base domain for ingress URLs (populated during ingress install)
BASE_DOMAIN=""

# Crossplane version
CROSSPLANE_VERSION="2.2.0"

# GKE configuration
GCP_PROJECT="demoo-ooclock"
GKE_MACHINE_TYPE="n2-standard-4"
GKE_NUM_NODES=3

# Artifact Registry for GKE demo app image
AR_LOCATION="us"
AR_REPO="cluster-whisperer"
AR_IMAGE="${AR_LOCATION}-docker.pkg.dev/${GCP_PROJECT}/${AR_REPO}/demo-app"

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
        if kubectl get pods -n "${namespace}" -l "${label}" --no-headers 2>/dev/null | grep -q .; then
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
    if kubectl wait --for=condition=ready pod \
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
# GCP Zone Auto-Detection
# =============================================================================

# Detect the nearest GCP zone based on geographic location.
# Uses ipinfo.io to geolocate, then maps to the nearest GCP region.
# Override with GCP_ZONE environment variable: GCP_ZONE=europe-west1-b ./setup.sh gcp
detect_gcp_zone() {
    # Allow explicit override via environment variable
    if [[ -n "${GCP_ZONE:-}" ]]; then
        log_info "Using GCP zone from environment: ${GCP_ZONE}"
        return
    fi

    log_info "Auto-detecting nearest GCP zone..."

    # Geolocate via ipinfo.io (free, no API key needed, returns country/region/timezone)
    local geo_info
    geo_info=$(curl -s --max-time 5 https://ipinfo.io/json 2>/dev/null || true)

    if [[ -z "${geo_info}" ]]; then
        GCP_ZONE="us-central1-b"
        log_warning "Could not detect location, defaulting to ${GCP_ZONE}"
        return
    fi

    local timezone
    timezone=$(echo "${geo_info}" | grep '"timezone"' | sed 's/.*: *"//;s/".*//' || true)

    # Map timezone prefix to nearest GCP region with good capacity.
    # Picks zone -b by default (avoids -a which is often most contended).
    case "${timezone}" in
        Europe/*)
            GCP_ZONE="europe-west1-b"  # Belgium — low latency for most of Europe
            ;;
        Asia/Tokyo|Asia/Seoul)
            GCP_ZONE="asia-northeast1-b"  # Tokyo
            ;;
        Asia/Shanghai|Asia/Hong_Kong|Asia/Taipei)
            GCP_ZONE="asia-east1-b"  # Taiwan
            ;;
        Asia/Kolkata|Asia/Mumbai)
            GCP_ZONE="asia-south1-b"  # Mumbai
            ;;
        Asia/Singapore|Asia/Jakarta)
            GCP_ZONE="asia-southeast1-b"  # Singapore
            ;;
        Australia/*)
            GCP_ZONE="australia-southeast1-b"  # Sydney
            ;;
        America/Sao_Paulo|America/Argentina/*)
            GCP_ZONE="southamerica-east1-b"  # Sao Paulo
            ;;
        America/Los_Angeles|America/Vancouver|US/Pacific)
            GCP_ZONE="us-west1-b"  # Oregon
            ;;
        America/Chicago|America/Denver|US/Central|US/Mountain)
            GCP_ZONE="us-central1-b"  # Iowa
            ;;
        America/New_York|America/Toronto|US/Eastern)
            GCP_ZONE="us-east1-b"  # South Carolina
            ;;
        *)
            GCP_ZONE="us-central1-b"  # Iowa — good general default
            ;;
    esac

    local country
    country=$(echo "${geo_info}" | grep '"country"' | sed 's/.*: *"//;s/".*//' || true)
    log_success "Detected location: ${country:-unknown} (${timezone:-unknown}) → ${GCP_ZONE}"
}

# =============================================================================
# Prerequisites Check (mode-specific)
# =============================================================================

check_prerequisites_kind() {
    log_info "Checking prerequisites for Kind mode..."

    local missing=()

    command -v kind &>/dev/null || missing+=("kind")
    command -v kubectl &>/dev/null || missing+=("kubectl")
    command -v helm &>/dev/null || missing+=("helm")
    command -v docker &>/dev/null || missing+=("docker")
    command -v node &>/dev/null || missing+=("node")
    command -v npx &>/dev/null || missing+=("npx (npm)")

    if [[ ${#missing[@]} -gt 0 ]]; then
        log_error "Missing required tools: ${missing[*]}"
        exit 1
    fi

    # Verify Docker is running
    if ! docker info &>/dev/null; then
        log_error "Docker is not running"
        exit 1
    fi

    log_success "All prerequisites met (Kind mode)"
}

check_prerequisites_gcp() {
    log_info "Checking prerequisites for GCP mode..."

    local missing=()

    command -v gcloud &>/dev/null || missing+=("gcloud")
    command -v kubectl &>/dev/null || missing+=("kubectl")
    command -v helm &>/dev/null || missing+=("helm")
    command -v docker &>/dev/null || missing+=("docker")
    command -v node &>/dev/null || missing+=("node")
    command -v npx &>/dev/null || missing+=("npx (npm)")

    if [[ ${#missing[@]} -gt 0 ]]; then
        log_error "Missing required tools: ${missing[*]}"
        exit 1
    fi

    # Check for gke-gcloud-auth-plugin (required for GKE auth)
    if ! gcloud components list --filter="id=gke-gcloud-auth-plugin" --format="value(state.name)" 2>/dev/null | grep -q "Installed"; then
        # Also check if it's available as a standalone binary
        if ! command -v gke-gcloud-auth-plugin &>/dev/null; then
            log_error "Missing gke-gcloud-auth-plugin. Install with: gcloud components install gke-gcloud-auth-plugin"
            exit 1
        fi
    fi

    # Verify gcloud is authenticated
    if ! gcloud auth list --filter="status=ACTIVE" --format="value(account)" 2>/dev/null | grep -q .; then
        log_error "No active gcloud account. Run: gcloud auth login"
        exit 1
    fi

    # Verify project access
    if ! gcloud projects describe "${GCP_PROJECT}" &>/dev/null; then
        log_error "Cannot access GCP project '${GCP_PROJECT}'. Check permissions."
        exit 1
    fi

    # Verify Docker is running (needed to build and push demo app image)
    if ! docker info &>/dev/null; then
        log_error "Docker is not running (needed to build demo app image)"
        exit 1
    fi

    log_success "All prerequisites met (GCP mode)"
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

    # Merge kubeconfig into dedicated file (additive, preserves other contexts)
    log_info "Merging credentials into ${KUBECONFIG_PATH}..."
    kind export kubeconfig --name "${CLUSTER_NAME}" --kubeconfig "${KUBECONFIG_PATH}"
    export KUBECONFIG="${KUBECONFIG_PATH}"
    log_success "KUBECONFIG written to ${KUBECONFIG_PATH}"

    # Verify cluster is accessible
    if kubectl cluster-info &>/dev/null; then
        log_success "Cluster is accessible via dedicated KUBECONFIG"
    else
        log_error "Cannot access cluster via ${KUBECONFIG_PATH}"
        exit 1
    fi
}

# =============================================================================
# GKE Cluster
# =============================================================================

create_gke_cluster() {
    log_info "Creating GKE cluster '${CLUSTER_NAME}' in project '${GCP_PROJECT}'..."

    # Check if any cluster-whisperer cluster already exists
    local existing
    existing=$(gcloud container clusters list \
        --project "${GCP_PROJECT}" \
        --filter="name~^${CLUSTER_NAME_PREFIX}" \
        --format="value(name)" 2>/dev/null || true)
    if [[ -n "${existing}" ]]; then
        log_warning "Existing cluster-whisperer GKE cluster(s) found: ${existing}"
        log_info "Run ./demo/cluster/teardown.sh first, or use a different name"
        exit 1
    fi

    # Set KUBECONFIG so gcloud merges credentials into the dedicated file
    export KUBECONFIG="${KUBECONFIG_PATH}"

    if gcloud container clusters create "${CLUSTER_NAME}" \
        --project "${GCP_PROJECT}" \
        --zone "${GCP_ZONE}" \
        --machine-type "${GKE_MACHINE_TYPE}" \
        --num-nodes "${GKE_NUM_NODES}" \
        --quiet; then
        log_success "GKE cluster '${CLUSTER_NAME}' created"
    else
        log_error "Failed to create GKE cluster"
        exit 1
    fi

    # gcloud create already fetches credentials when KUBECONFIG is set
    log_success "Credentials merged into ${KUBECONFIG_PATH}"

    # Verify cluster is accessible
    if kubectl cluster-info &>/dev/null; then
        log_success "Cluster is accessible via dedicated KUBECONFIG"
    else
        log_error "Cannot access cluster via ${KUBECONFIG_PATH}"
        exit 1
    fi
}

# =============================================================================
# Ingress Controller
# =============================================================================

# Install NGINX Ingress Controller using the Kind-specific manifest.
# The Kind cluster config maps host:80 → container:80 and host:443 → container:443,
# so ingress is accessible directly on localhost.
install_kind_ingress() {
    log_info "Installing NGINX Ingress Controller for Kind..."

    kubectl apply -f \
        "https://raw.githubusercontent.com/kubernetes/ingress-nginx/controller-${INGRESS_NGINX_VERSION}/deploy/static/provider/kind/deploy.yaml"

    wait_for_pods "ingress-nginx" "app.kubernetes.io/component=controller" 180

    BASE_DOMAIN="127.0.0.1.nip.io"
    log_success "NGINX Ingress Controller installed (Kind)"
    log_success "Base domain: ${BASE_DOMAIN}"
}

# Install NGINX Ingress Controller on GKE using the cloud manifest.
# Polls for the LoadBalancer external IP, then sets BASE_DOMAIN.
install_gcp_ingress() {
    log_info "Installing NGINX Ingress Controller for GKE..."

    kubectl apply -f \
        "https://raw.githubusercontent.com/kubernetes/ingress-nginx/controller-${INGRESS_NGINX_VERSION}/deploy/static/provider/cloud/deploy.yaml"

    wait_for_pods "ingress-nginx" "app.kubernetes.io/component=controller" 180

    # Poll for LoadBalancer external IP
    log_info "Waiting for LoadBalancer external IP (up to 5 minutes)..."
    local external_ip=""
    local attempts=60
    local interval=5

    for ((i=1; i<=attempts; i++)); do
        external_ip=$(kubectl get svc ingress-nginx-controller \
            -n ingress-nginx \
            -o jsonpath='{.status.loadBalancer.ingress[0].ip}' 2>/dev/null || true)

        if [[ -n "${external_ip}" ]]; then
            break
        fi

        if [[ $((i % 6)) -eq 0 ]]; then
            echo -e "  ${BLUE}[${i}/${attempts}]${NC} Still waiting for external IP..."
        fi
        sleep $interval
    done

    if [[ -z "${external_ip}" ]]; then
        log_error "LoadBalancer external IP not assigned after $((attempts * interval))s"
        log_error "Check: kubectl get svc -n ingress-nginx"
        return 1
    fi

    BASE_DOMAIN="${external_ip}.nip.io"
    log_success "NGINX Ingress Controller installed (GKE)"
    log_success "External IP: ${external_ip}"
    log_success "Base domain: ${BASE_DOMAIN}"
}

# Dispatcher: install the ingress controller for the current mode.
install_ingress_controller() {
    if [[ "${MODE}" == "kind" ]]; then
        install_kind_ingress
    else
        install_gcp_ingress
    fi
}

# Create Ingress resources for cluster-whisperer and Jaeger UI.
# Called after the services exist so the Ingress has valid backends.
create_ingress_resources() {
    log_info "Creating Ingress resources (base domain: ${BASE_DOMAIN})..."

    # cluster-whisperer Ingress
    kubectl apply -f - <<EOF
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: cluster-whisperer
  namespace: cluster-whisperer
  annotations:
    nginx.ingress.kubernetes.io/proxy-read-timeout: "300"
    nginx.ingress.kubernetes.io/proxy-send-timeout: "300"
spec:
  ingressClassName: nginx
  rules:
  - host: cluster-whisperer.${BASE_DOMAIN}
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: cluster-whisperer
            port:
              number: 3000
EOF

    log_success "Ingress created: http://cluster-whisperer.${BASE_DOMAIN}"

    # Jaeger UI Ingress
    kubectl apply -f - <<EOF
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: jaeger
  namespace: jaeger
spec:
  ingressClassName: nginx
  rules:
  - host: jaeger.${BASE_DOMAIN}
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: jaeger
            port:
              number: 16686
EOF

    log_success "Ingress created: http://jaeger.${BASE_DOMAIN}"

    # Chroma Ingress — external access to the in-cluster Chroma instance.
    # Needed for locally-run agent to reach vector DB via ingress URL.
    kubectl apply -f - <<EOF
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: chroma
  namespace: chroma
  annotations:
    nginx.ingress.kubernetes.io/proxy-body-size: "10m"
    nginx.ingress.kubernetes.io/proxy-read-timeout: "300"
    nginx.ingress.kubernetes.io/proxy-send-timeout: "300"
spec:
  ingressClassName: nginx
  rules:
  - host: chroma.${BASE_DOMAIN}
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: chroma-chromadb
            port:
              number: 8000
EOF

    log_success "Ingress created: http://chroma.${BASE_DOMAIN}"

    # Qdrant Ingress — external access to the in-cluster Qdrant instance.
    # Needed for locally-run agent to reach vector DB via ingress URL.
    kubectl apply -f - <<EOF
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: qdrant
  namespace: qdrant
  annotations:
    nginx.ingress.kubernetes.io/proxy-body-size: "10m"
    nginx.ingress.kubernetes.io/proxy-read-timeout: "300"
    nginx.ingress.kubernetes.io/proxy-send-timeout: "300"
spec:
  ingressClassName: nginx
  rules:
  - host: qdrant.${BASE_DOMAIN}
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: qdrant
            port:
              number: 6333
EOF

    log_success "Ingress created: http://qdrant.${BASE_DOMAIN}"

    # OTel Collector Ingress — external access to the OTLP HTTP receiver.
    # Needed for locally-run agent to export traces into the cluster.
    kubectl apply -f - <<EOF
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: otel-collector
  namespace: otel-collector
spec:
  ingressClassName: nginx
  rules:
  - host: otel.${BASE_DOMAIN}
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: otel-collector-opentelemetry-collector
            port:
              number: 4318
EOF

    log_success "Ingress created: http://otel.${BASE_DOMAIN}"

    # Demo app Ingress — accessible to the audience once the app is running.
    # While the app is in CrashLoopBackOff, nginx returns 502 (no healthy backend).
    # The readiness probe ensures traffic only routes when the app is actually serving.
    kubectl apply -f - <<EOF
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: demo-app
  namespace: default
spec:
  ingressClassName: nginx
  rules:
  - host: demo-app.${BASE_DOMAIN}
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: demo-app
            port:
              number: 80
EOF

    log_success "Ingress created: http://demo-app.${BASE_DOMAIN}"
}

# Generate a demo/.env file with resolved ingress URLs and kubeconfig path.
# The presenter sources this file before the demo to set infrastructure URLs.
# Audience-facing env vars (CLUSTER_WHISPERER_AGENT, _TOOLS, _VECTOR_BACKEND)
# are set live on stage after each vote — they are NOT included here.
generate_demo_env() {
    local demo_env="${REPO_ROOT}/demo/.env"
    log_info "Generating demo environment file: ${demo_env}"

    # For Kind mode, OTel uses the direct port mapping (localhost:14318)
    # since the host already has port 14318 forwarded to the OTel Collector.
    # For GKE mode, use the ingress URL.
    local otel_endpoint
    if [[ "${MODE}" == "kind" ]]; then
        otel_endpoint="http://localhost:14318"
    else
        otel_endpoint="http://otel.${BASE_DOMAIN}"
    fi

    # Resolve API keys from vals (gitignored — safe to inline)
    local anthropic_key voyage_key dd_api_key dd_app_key
    anthropic_key=$(vals eval -f "${REPO_ROOT}/.vals.yaml" 2>/dev/null | grep ANTHROPIC_API_KEY | cut -d' ' -f2)
    voyage_key=$(vals eval -f "${REPO_ROOT}/.vals.yaml" 2>/dev/null | grep VOYAGE_API_KEY | cut -d' ' -f2)
    dd_api_key=$(vals eval -f "${REPO_ROOT}/.vals.yaml" 2>/dev/null | grep DD_API_KEY | cut -d' ' -f2)
    dd_app_key=$(vals eval -f "${REPO_ROOT}/.vals.yaml" 2>/dev/null | grep DD_APP_KEY | cut -d' ' -f2)

    cat > "${demo_env}" <<EOF
# Generated by setup.sh — source this before the demo.
# This file is gitignored. Safe to contain API keys.

# Kubeconfig for cluster-whisperer
export CLUSTER_WHISPERER_KUBECONFIG=${KUBECONFIG_PATH}

# Vector DB ingress URLs
export CLUSTER_WHISPERER_CHROMA_URL=http://chroma.${BASE_DOMAIN}
export CLUSTER_WHISPERER_QDRANT_URL=http://qdrant.${BASE_DOMAIN}

# Multi-turn conversation memory (always "demo" — not audience-dependent)
export CLUSTER_WHISPERER_THREAD=demo

# OTel tracing configuration
export OTEL_TRACING_ENABLED=true
export OTEL_EXPORTER_TYPE=otlp
export OTEL_EXPORTER_OTLP_ENDPOINT=${otel_endpoint}

# Enable AI payload capture for Datadog LLM Observability CONTENT column
# This populates gen_ai.input.messages and gen_ai.output.messages on root spans
export OTEL_CAPTURE_AI_PAYLOADS=true

# Suppress OTel initialization logs in CLI output
export CLUSTER_WHISPERER_QUIET=true

# Demo app URL — 502 until the agent fixes the cluster, then shows the spider page
export DEMO_APP_URL=http://demo-app.${BASE_DOMAIN}

# API keys (resolved from .vals.yaml at setup time — only set if non-empty)
${anthropic_key:+export ANTHROPIC_API_KEY=${anthropic_key}}
${voyage_key:+export VOYAGE_API_KEY=${voyage_key}}
${dd_api_key:+export DD_API_KEY=${dd_api_key}}
${dd_app_key:+export DD_APP_KEY=${dd_app_key}}

# Audience-facing vars — set live on stage after each vote:
#   export CLUSTER_WHISPERER_AGENT=langgraph   # (or vercel)
#   export CLUSTER_WHISPERER_TOOLS=kubectl     # progressively add: kubectl,vector → kubectl,vector,apply
#   export CLUSTER_WHISPERER_VECTOR_BACKEND=qdrant  # (or chroma)
EOF

    log_success "Demo environment file generated: ${demo_env}"
    log_info "Before the demo, run: source ${demo_env}"
}

# =============================================================================
# Crossplane Installation
# =============================================================================

install_crossplane() {
    log_info "Installing Crossplane v${CROSSPLANE_VERSION}..."

    # Add Crossplane Helm repo
    helm repo add crossplane-stable https://charts.crossplane.io/stable --force-update &>/dev/null

    # Check if already installed (idempotency)
    if helm list -n crossplane-system 2>/dev/null | grep -q crossplane; then
        log_success "Crossplane already installed"
        return
    fi

    helm install crossplane crossplane-stable/crossplane \
        \
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
    log_info "Installing curated Crossplane provider subset (16 sub-providers)..."
    log_info "This registers ~365 CRDs. First run pulls images (slow)."
    log_info "Subsequent runs use cached images and are much faster."

    # Batch 0 (family providers) is always required — sub-providers depend on it.
    # Both modes use the same curated subset for fast, reliable setup.
    local batch_files
    batch_files=$(ls "${SCRIPT_DIR}/manifests/crossplane-providers-batch-0.yaml" \
                     "${SCRIPT_DIR}/manifests/crossplane-providers-kind.yaml" 2>/dev/null | sort)

    if [[ -z "${batch_files}" ]]; then
        log_error "No provider batch files found in ${SCRIPT_DIR}/manifests/"
        exit 1
    fi

    local batch_num=0
    local total_batches
    total_batches=$(echo "${batch_files}" | wc -l | tr -d ' ')

    for batch_file in ${batch_files}; do
        local count
        count=$(grep -c 'kind: Provider' "${batch_file}" || true)
        log_info "Batch $((batch_num + 1))/${total_batches}: applying ${count} providers..."

        kubectl apply -f "${batch_file}"
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

    # Wait for CRD registration with mode-specific targets
    wait_for_crds
}

# Wait for Crossplane provider CRDs to register, showing progress along the way.
# Provider family packages install sub-providers that each register their own CRDs.
# This is the slowest part of setup (5-10 minutes on GKE, 3-5 minutes on Kind).
wait_for_crds() {
    local target=300   # Curated 16 sub-providers: ~365 CRDs expected
    local timeout=1800 # 30 minutes — cold starts pull ~14 container images
    local elapsed=0
    local interval=10
    local prev_count=0

    log_info "Waiting for CRD registration (target: ${target}+, timeout: ${timeout}s)..."

    while [[ $elapsed -lt $timeout ]]; do
        local crd_count
        # Tolerate transient kubectl failures during CRD registration (API server
        # may be briefly unavailable while providers register many CRDs)
        crd_count=$(kubectl get crds --no-headers 2>/dev/null | wc -l | tr -d ' ') || crd_count=0

        # Guard against transient blips: if the count drops significantly from
        # a previously observed value, retry once before accepting it. A single
        # kubectl failure can return 0 lines — this prevents a false regression.
        if [[ $prev_count -gt 0 && $crd_count -lt $((prev_count / 2)) ]]; then
            log_warning "Transient CRD count blip detected: ${crd_count} (was ${prev_count}), retrying..."
            sleep 2
            crd_count=$(kubectl get crds --no-headers 2>/dev/null | wc -l | tr -d ' ') || crd_count=0
            if [[ $crd_count -lt $((prev_count / 2)) ]]; then
                log_warning "CRD count confirmed at ${crd_count} after retry (was ${prev_count})"
            else
                log_info "CRD count recovered to ${crd_count} after retry"
            fi
        fi

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

    # Didn't hit target but may still have enough CRDs for the demo.
    # Retry the final count to avoid failing on a transient blip at timeout boundary.
    local final_count
    local min_acceptable=150  # Minimum CRD count to consider "good enough" for the demo
    final_count=$(kubectl get crds --no-headers 2>/dev/null | wc -l | tr -d ' ') || final_count=0
    if [[ $final_count -lt $min_acceptable ]]; then
        sleep 2
        final_count=$(kubectl get crds --no-headers 2>/dev/null | wc -l | tr -d ' ') || final_count=0
    fi
    if [[ $final_count -ge $min_acceptable ]]; then
        log_warning "CRD registration timed out with ${final_count} CRDs (target was ${target}+)"
        log_warning "This may be enough for the demo — check provider status:"
        kubectl get providers 2>/dev/null || true
        return 0
    fi

    log_error "CRD registration failed: only ${final_count} CRDs after ${timeout}s"
    log_error "Check provider status:"
    kubectl get providers 2>/dev/null || true
    return 1
}

# Wait for any in-progress GKE cluster operations (e.g., control plane resize).
# GKE auto-resizes the control plane when object count spikes (hundreds of CRDs).
# During resize, the API server is temporarily unreachable — helm installs fail
# with "TLS handshake timeout." This function polls until all operations complete.
wait_for_gke_operations() {
    log_info "Checking for in-progress GKE cluster operations..."

    local timeout=600
    local elapsed=0
    local interval=15

    while [[ $elapsed -lt $timeout ]]; do
        local running_ops
        running_ops=$(gcloud container operations list \
            --project "${GCP_PROJECT}" \
            --zone "${GCP_ZONE}" \
            --filter="targetLink~${CLUSTER_NAME} AND status=RUNNING" \
            --format="value(name,operationType)" 2>/dev/null || true)

        if [[ -z "${running_ops}" ]]; then
            log_success "No in-progress GKE operations"
            return 0
        fi

        if (( elapsed % 60 == 0 )); then
            local op_type
            op_type=$(echo "${running_ops}" | head -1 | awk '{print $2}')
            log_info "  [${elapsed}s] Waiting for GKE operation: ${op_type:-unknown}"
        fi

        sleep $interval
        elapsed=$((elapsed + interval))
    done

    log_warning "GKE operations still running after ${timeout}s — proceeding anyway"
}

# Wait until the Kubernetes API server is actually responding to requests.
# gcloud may report a resize operation as complete slightly before the API
# server is fully back. This catches that gap.
wait_for_api_server() {
    log_info "Verifying API server connectivity..."

    local timeout=300
    local elapsed=0
    local interval=10

    while [[ $elapsed -lt $timeout ]]; do
        if kubectl get nodes --request-timeout=5s &>/dev/null; then
            log_success "API server is responding"
            return 0
        fi
        if (( elapsed % 30 == 0 && elapsed > 0 )); then
            log_info "  [${elapsed}s] API server not responding yet, waiting..."
        fi
        sleep $interval
        elapsed=$((elapsed + interval))
    done

    log_error "API server did not respond within ${timeout}s"
    return 1
}

# =============================================================================
# Platform Composition (The "Needle in the Haystack")
# =============================================================================

# Install the function-patch-and-transform Crossplane function, required by
# the Composition's Pipeline mode. The function doesn't need to reconcile
# anything — it just needs to exist so the Composition is valid.
install_composition_function() {
    log_info "Installing function-patch-and-transform..."

    # Check if already installed (idempotency)
    if kubectl get functions.pkg.crossplane.io \
        crossplane-contrib-function-patch-and-transform &>/dev/null 2>&1; then
        log_success "function-patch-and-transform already installed"
        return
    fi

    kubectl apply -f - <<'EOF'
apiVersion: pkg.crossplane.io/v1beta1
kind: Function
metadata:
  name: crossplane-contrib-function-patch-and-transform
spec:
  package: xpkg.upbound.io/crossplane-contrib/function-patch-and-transform:v0.10.1
EOF

    log_success "function-patch-and-transform installed"
}

# Configure provider-kubernetes for composing native K8s resources.
# The provider is installed via the batch manifests; this function waits
# for its CRDs, grants RBAC, and applies the ProviderConfig.
configure_provider_kubernetes() {
    log_info "Configuring provider-kubernetes for in-cluster access..."

    # Crossplane v2 uses ManagedResourceDefinitions (MRDs) + MRAPs instead of
    # registering CRDs directly. The default MRAP activates all MRDs ("*"), but
    # activation is asynchronous — the provider becomes Healthy before the MRAP
    # converts its MRDs into CRDs.
    #
    # Step 1: Wait for the Provider to be Healthy (image pulled, pod running).
    # Step 2: Wait for the Object CRD to appear (MRAP activates the MRD → CRD).
    local elapsed=0
    local timeout=300
    log_info "Waiting for provider-kubernetes to become healthy (timeout: ${timeout}s)..."
    while [[ $elapsed -lt $timeout ]]; do
        local pk_healthy
        pk_healthy=$(kubectl get providers.pkg.crossplane.io provider-kubernetes \
            -o jsonpath='{.status.conditions[?(@.type=="Healthy")].status}' 2>/dev/null || true)
        if [[ "${pk_healthy}" == "True" ]]; then
            log_success "provider-kubernetes is healthy"
            break
        fi
        if (( elapsed % 30 == 0 && elapsed > 0 )); then
            local pk_status
            pk_status=$(kubectl get providers.pkg.crossplane.io provider-kubernetes \
                -o jsonpath='{.status.conditions[*].reason}' 2>/dev/null || echo "unknown")
            log_info "  [${elapsed}s] provider-kubernetes status: ${pk_status}"
        fi
        sleep 10
        elapsed=$((elapsed + 10))
    done

    # Step 2: Wait for the Object CRD to appear via MRAP activation.
    # Crossplane v2's default MRAP activates MRDs that exist when it's created.
    # If provider-kubernetes registers its MRDs after the MRAP was created,
    # they stay Inactive. Fix: patch the MRAP to trigger re-evaluation.
    log_info "Waiting for Object CRD activation via MRAP..."
    local crd_elapsed=0
    local crd_timeout=180
    local mrap_refreshed=false
    while [[ $crd_elapsed -lt $crd_timeout ]]; do
        # Check for both possible CRD names (legacy and v2 namespaced)
        if kubectl get crd objects.kubernetes.crossplane.io &>/dev/null 2>&1; then
            log_success "Object CRD registered (objects.kubernetes.crossplane.io)"
            break
        fi
        if kubectl get crd objects.kubernetes.m.crossplane.io &>/dev/null 2>&1; then
            log_success "Object CRD registered (objects.kubernetes.m.crossplane.io)"
            break
        fi

        # If MRDs exist but are Inactive after 30s, refresh the MRAP
        if [[ "${mrap_refreshed}" == "false" && $crd_elapsed -ge 30 ]]; then
            local inactive_count
            inactive_count=$(kubectl get mrds 2>/dev/null | grep "kubernetes.*Inactive" | wc -l | tr -d ' ') || inactive_count=0
            if [[ $inactive_count -gt 0 ]]; then
                log_info "  Found ${inactive_count} Inactive kubernetes MRDs — refreshing default MRAP..."
                # Patch the default MRAP to trigger re-evaluation of all MRDs
                kubectl patch mrap default --type=merge \
                    -p '{"spec":{"activate":["*"]}}' 2>/dev/null || \
                # If no default MRAP exists, create one
                kubectl apply -f - <<'MRAP_EOF' 2>/dev/null || true
apiVersion: apiextensions.crossplane.io/v1alpha1
kind: ManagedResourceActivationPolicy
metadata:
  name: provider-kubernetes
spec:
  activate:
  - "*.kubernetes.crossplane.io"
  - "*.kubernetes.m.crossplane.io"
MRAP_EOF
                mrap_refreshed=true
                log_info "  MRAP refreshed — waiting for activation..."
            fi
        fi

        if (( crd_elapsed % 30 == 0 )); then
            local mrd_count
            mrd_count=$(kubectl get mrds 2>/dev/null | grep -c "kubernetes" || echo "0")
            log_info "  [${crd_elapsed}s] kubernetes MRDs found: ${mrd_count}, waiting for CRD activation..."
        fi
        sleep 10
        crd_elapsed=$((crd_elapsed + 10))
    done

    # Final check — if neither CRD exists, show diagnostics
    if ! kubectl get crd objects.kubernetes.crossplane.io &>/dev/null 2>&1 && \
       ! kubectl get crd objects.kubernetes.m.crossplane.io &>/dev/null 2>&1; then
        log_error "provider-kubernetes Object CRD not activated within ${crd_timeout}s"
        log_error "MRD status:"
        kubectl get mrds 2>/dev/null | grep -i "kubernetes\|object" || true
        log_error "MRAP status:"
        kubectl get mrap -o wide 2>/dev/null || true
        return 1
    fi

    # Grant cluster-admin to provider-kubernetes so it can create
    # Deployments, Services, and other resources in any namespace
    local sa_name
    sa_name=$(kubectl get sa -n crossplane-system -o name 2>/dev/null \
        | grep provider-kubernetes | head -1 | sed 's|serviceaccount/||') || true

    if [[ -n "${sa_name}" ]]; then
        kubectl create clusterrolebinding provider-kubernetes-admin-binding \
            --clusterrole=cluster-admin \
            --serviceaccount="crossplane-system:${sa_name}" \
            2>/dev/null || log_info "RBAC binding already exists"
        log_success "RBAC configured for provider-kubernetes"
    else
        log_warning "provider-kubernetes service account not found — RBAC skipped"
    fi

    # Apply ClusterProviderConfig for in-cluster identity
    kubectl apply -f "${SCRIPT_DIR}/manifests/providerconfig-k8s.yaml"
    log_success "ClusterProviderConfig kubernetes-in-cluster applied"

    # Restart the provider-kubernetes pod so it picks up the new
    # ClusterProviderConfig. Without this, the pod starts before the config
    # exists and silently ignores Object resources.
    log_info "Restarting provider-kubernetes pod to pick up ClusterProviderConfig..."
    kubectl delete pod -n crossplane-system \
        -l "pkg.crossplane.io/revision=$(kubectl get providers.pkg.crossplane.io provider-kubernetes \
            -o jsonpath='{.status.currentRevision}' 2>/dev/null)" \
        --wait=false 2>/dev/null || true
    sleep 10
    wait_for_pods "crossplane-system" "pkg.crossplane.io/revision=$(kubectl get providers.pkg.crossplane.io provider-kubernetes \
        -o jsonpath='{.status.currentRevision}' 2>/dev/null)" 120
    log_success "provider-kubernetes pod restarted"
}

# Apply 20 ManagedService XRDs and Compositions — one real (platform.acme.io
# for Whitney/Viktor's You Choose app) and 19 decoys for fake teams. All 20
# look identical from `kubectl get crd`, forcing the agent to use vector search
# with organizational context to find the right one.
install_platform_compositions() {
    log_info "Applying 20 ManagedService XRDs and Compositions..."

    install_composition_function
    configure_provider_kubernetes

    # Apply the real XRD + Composition first
    kubectl apply -f "${SCRIPT_DIR}/manifests/xrd.yaml"
    kubectl apply -f "${SCRIPT_DIR}/manifests/composition.yaml"
    log_success "Real XRD + Composition applied (platform.acme.io)"

    # Apply all 19 decoy XRDs + Compositions
    local decoy_count=0
    for decoy_file in "${SCRIPT_DIR}/manifests/decoy-xrds/"*.yaml; do
        kubectl apply -f "${decoy_file}" 2>&1 | grep -v "^$" || true
        decoy_count=$((decoy_count + 1))
    done
    log_success "Applied ${decoy_count} decoy XRDs + Compositions"

    # Wait for all 20 ManagedService CRDs to register
    log_info "Waiting for ManagedService CRD registration (20 expected)..."
    local elapsed=0
    local timeout=120
    while [[ $elapsed -lt $timeout ]]; do
        local registered
        registered=$(kubectl get crd 2>/dev/null | grep -c "managedservices.*acme.io" || true)
        if [[ $registered -ge 20 ]]; then
            break
        fi
        sleep 5
        elapsed=$((elapsed + 5))
        if (( elapsed % 20 == 0 )); then
            log_info "  [${elapsed}s] ${registered}/20 ManagedService CRDs registered"
        fi
    done

    local final_count
    final_count=$(kubectl get crd 2>/dev/null | grep -c "managedservices.*acme.io" || true)
    if [[ $final_count -ge 20 ]]; then
        log_success "All ${final_count} ManagedService CRDs registered"
    else
        log_warning "Only ${final_count}/20 ManagedService CRDs registered within ${timeout}s"
    fi
}

# =============================================================================
# Vector Databases
# =============================================================================

# Deploy Chroma vector database for storing CRD capability descriptions.
# The capability inference pipeline (later in setup) populates it.
# Accessible at chroma-chromadb.chroma:8000 from within the cluster.
install_chroma() {
    log_info "Installing Chroma vector database..."

    helm repo add chroma https://amikos-tech.github.io/chromadb-chart/ --force-update &>/dev/null

    # Check if already installed (idempotency)
    if helm list -n chroma 2>/dev/null | grep -q chroma; then
        log_success "Chroma already installed"
        return
    fi

    helm install chroma chroma/chromadb \
        \
        --namespace chroma \
        --create-namespace \
        --values "${SCRIPT_DIR}/helm-values/chroma.yaml" \
        --wait --timeout 180s

    log_success "Chroma installed"

    # The chromadb chart uses app.kubernetes.io/instance=chroma as pod label
    wait_for_pods "chroma" "app.kubernetes.io/instance=chroma" 180
}

# Deploy Qdrant vector database — the alternative backend for the demo's
# "choose your own adventure" audience vote. Same data, different engine.
# Accessible at qdrant.qdrant:6333 (REST) and :6334 (gRPC) from within the cluster.
install_qdrant() {
    log_info "Installing Qdrant vector database..."

    helm repo add qdrant https://qdrant.github.io/qdrant-helm --force-update &>/dev/null

    # Check if already installed (idempotency)
    if helm list -n qdrant 2>/dev/null | grep -q qdrant; then
        log_success "Qdrant already installed"
        return
    fi

    helm install qdrant qdrant/qdrant \
        \
        --namespace qdrant \
        --create-namespace \
        --values "${SCRIPT_DIR}/helm-values/qdrant.yaml" \
        --wait --timeout 180s

    log_success "Qdrant installed"

    # The qdrant chart uses app.kubernetes.io/instance=qdrant as pod label
    wait_for_pods "qdrant" "app.kubernetes.io/instance=qdrant" 180
}

# Verify both vector databases are responding to health checks via in-cluster
# port-forward probes. This catches cases where pods are "Ready" but the
# application inside hasn't fully started.
verify_vector_dbs() {
    log_info "Verifying vector database health..."

    local failures=0
    local retries=12
    local retry_interval=10

    # Chroma health check with retries: GET /api/v1/heartbeat
    # Uses port-forward + local curl because the container image may lack wget/curl.
    local chroma_ok=false
    for ((i=1; i<=retries; i++)); do
        local chroma_health
        kubectl port-forward -n chroma \
            svc/chroma-chromadb 18000:8000 &>/dev/null &
        local pf_pid=$!
        sleep 2
        chroma_health=$(curl -sf http://localhost:18000/api/v2/heartbeat 2>/dev/null || true)
        kill $pf_pid 2>/dev/null || true
        wait $pf_pid 2>/dev/null || true
        if [[ -n "${chroma_health}" ]]; then
            log_success "Chroma is responding (heartbeat ok)"
            chroma_ok=true
            break
        fi
        if [[ $i -lt $retries ]]; then
            echo -e "  ${BLUE}[attempt ${i}/${retries}]${NC} Chroma not ready, retrying in ${retry_interval}s..."
            sleep $retry_interval
        fi
    done
    if [[ "${chroma_ok}" != "true" ]]; then
        log_warning "Chroma health check failed after ${retries} attempts"
        failures=$((failures + 1))
    fi

    # Qdrant health check with retries: GET /healthz
    # Uses port-forward + local curl because the container image may lack wget/curl.
    local qdrant_ok=false
    for ((i=1; i<=retries; i++)); do
        local qdrant_health
        kubectl port-forward -n qdrant \
            qdrant-0 16333:6333 &>/dev/null &
        local pf_pid=$!
        sleep 2
        qdrant_health=$(curl -sf http://localhost:16333/healthz 2>/dev/null || true)
        kill $pf_pid 2>/dev/null || true
        wait $pf_pid 2>/dev/null || true
        if [[ -n "${qdrant_health}" ]]; then
            log_success "Qdrant is responding (healthz ok)"
            qdrant_ok=true
            break
        fi
        if [[ $i -lt $retries ]]; then
            echo -e "  ${BLUE}[attempt ${i}/${retries}]${NC} Qdrant not ready, retrying in ${retry_interval}s..."
            sleep $retry_interval
        fi
    done
    if [[ "${qdrant_ok}" != "true" ]]; then
        log_warning "Qdrant health check failed after ${retries} attempts"
        failures=$((failures + 1))
    fi

    if [[ $failures -eq 0 ]]; then
        log_success "Both vector databases verified and healthy"
    fi
}

# =============================================================================
# Observability Backends
# =============================================================================

# Deploy Jaeger v2 for distributed tracing visualization.
# Receives OTLP traces directly (gRPC on 4317, HTTP on 4318) and stores
# them in memory. The Jaeger UI (port 16686) shows trace timelines.
#
# For Kind: NodePort service with port 30686 mapped to host 16686 via
# Kind's extraPortMappings. Accessible at http://localhost:16686.
# For GKE: ClusterIP service, accessible via port-forward.
install_jaeger() {
    log_info "Installing Jaeger v2 (tracing backend)..."

    helm repo add jaegertracing https://jaegertracing.github.io/helm-charts --force-update &>/dev/null

    # Check if already installed (idempotency)
    if helm list -n jaeger 2>/dev/null | grep -q jaeger; then
        log_success "Jaeger already installed"
        return
    fi

    helm install jaeger jaegertracing/jaeger \
        \
        --namespace jaeger \
        --create-namespace \
        --values "${SCRIPT_DIR}/helm-values/jaeger.yaml" \
        --wait --timeout 300s

    log_success "Jaeger installed"

    # For Kind: patch the service to NodePort with specific port for Jaeger UI.
    # The Kind cluster config maps host:16686 → container:30686, so the Jaeger
    # UI is accessible at http://localhost:16686 on the host.
    # Strategic merge patch matches ports by the "port" field.
    if [[ "${MODE}" == "kind" ]]; then
        log_info "Patching Jaeger service for Kind NodePort access..."
        kubectl patch svc jaeger \
            -n jaeger \
            --type=strategic \
            -p '{"spec":{"type":"NodePort","ports":[{"port":16686,"nodePort":30686}]}}'
        log_success "Jaeger UI accessible at http://localhost:16686"
    fi

    wait_for_pods "jaeger" "app.kubernetes.io/instance=jaeger" 180
}

# Deploy OTel Collector (contrib distribution) with Datadog exporter.
# Receives OTLP traces in-cluster and exports to Datadog (datadoghq.com).
# Uses a K8s secret for DD_API_KEY (must be set in the environment).
#
# For Kind: NodePort service with ports 30417 (gRPC) and 30418 (HTTP)
# mapped to host ports 14317 and 14318 via Kind's extraPortMappings.
# For GKE: ClusterIP service, accessible from within the cluster.
install_otel_collector() {
    log_info "Installing OTel Collector (contrib) with Datadog exporter..."

    helm repo add open-telemetry https://open-telemetry.github.io/opentelemetry-helm-charts --force-update &>/dev/null

    # Check if already installed (idempotency)
    if helm list -n otel-collector 2>/dev/null | grep -q otel-collector; then
        log_success "OTel Collector already installed"
        return
    fi

    # Create K8s secret with DD_API_KEY from the environment.
    # The collector config references it as ${env:DD_API_KEY}.
    if [[ -z "${DD_API_KEY:-}" ]]; then
        log_warning "DD_API_KEY not set — skipping OTel Collector deployment"
        log_warning "Export DD_API_KEY before running setup.sh"
        return
    fi

    kubectl create namespace otel-collector \
        --dry-run=client -o yaml | kubectl apply -f -

    kubectl create secret generic otel-collector-datadog \
        --namespace otel-collector \
        --from-literal=api-key="${DD_API_KEY}" \
        --dry-run=client -o yaml | kubectl apply -f -

    helm install otel-collector open-telemetry/opentelemetry-collector \
        \
        --namespace otel-collector \
        --values "${SCRIPT_DIR}/helm-values/otel-collector.yaml" \
        --wait --timeout 180s

    log_success "OTel Collector installed"

    # For Kind: patch the service to NodePort with specific ports for OTLP.
    # The Kind cluster config maps host:14317 → container:30417 (gRPC)
    # and host:14318 → container:30418 (HTTP).
    if [[ "${MODE}" == "kind" ]]; then
        log_info "Patching OTel Collector service for Kind NodePort access..."
        kubectl patch svc otel-collector-opentelemetry-collector \
            -n otel-collector \
            --type=strategic \
            -p '{"spec":{"type":"NodePort","ports":[{"port":4317,"nodePort":30417},{"port":4318,"nodePort":30418}]}}'
        log_success "OTLP receivers accessible at localhost:14317 (gRPC) and localhost:14318 (HTTP)"
    fi

    wait_for_pods "otel-collector" "app.kubernetes.io/instance=otel-collector" 180
}

# Verify both observability backends are healthy and accepting traces.
# Checks that Jaeger has an OTLP receiver and OTel Collector is running.
verify_observability() {
    log_info "Verifying observability backends..."

    local failures=0
    local retries=6
    local retry_interval=10

    # Jaeger health check with retries via the v2 healthcheck extension
    # Uses port-forward + local curl for consistency with other health checks.
    local jaeger_ok=false
    for ((i=1; i<=retries; i++)); do
        local jaeger_health
        kubectl port-forward -n jaeger \
            deploy/jaeger 13133:13133 &>/dev/null &
        local pf_pid=$!
        sleep 2
        jaeger_health=$(curl -sf http://localhost:13133/status 2>/dev/null || true)
        kill $pf_pid 2>/dev/null || true
        wait $pf_pid 2>/dev/null || true
        if [[ -n "${jaeger_health}" ]]; then
            log_success "Jaeger is responding (health check ok)"
            jaeger_ok=true
            break
        fi
        if [[ $i -lt $retries ]]; then
            echo -e "  ${BLUE}[attempt ${i}/${retries}]${NC} Jaeger not ready, retrying in ${retry_interval}s..."
            sleep $retry_interval
        fi
    done
    if [[ "${jaeger_ok}" != "true" ]]; then
        log_warning "Jaeger health check failed after ${retries} attempts"
        failures=$((failures + 1))
    fi

    # OTel Collector health check with retries (default health extension on 13133)
    # Uses port-forward + local curl because the collector image is distroless.
    local otel_ok=false
    for ((i=1; i<=retries; i++)); do
        local otel_health
        kubectl port-forward -n otel-collector \
            deploy/otel-collector-opentelemetry-collector 13134:13133 &>/dev/null &
        local pf_pid=$!
        sleep 2
        otel_health=$(curl -sf http://localhost:13134 2>/dev/null || true)
        kill $pf_pid 2>/dev/null || true
        wait $pf_pid 2>/dev/null || true
        if [[ -n "${otel_health}" ]]; then
            log_success "OTel Collector is responding (health check ok)"
            otel_ok=true
            break
        fi
        if [[ $i -lt $retries ]]; then
            echo -e "  ${BLUE}[attempt ${i}/${retries}]${NC} OTel Collector not ready, retrying in ${retry_interval}s..."
            sleep $retry_interval
        fi
    done
    if [[ "${otel_ok}" != "true" ]]; then
        log_warning "OTel Collector health check failed after ${retries} attempts"
        failures=$((failures + 1))
    fi

    if [[ $failures -eq 0 ]]; then
        log_success "Both observability backends verified and healthy"
    fi
}

# Verify the trace pipeline end-to-end: send a test trace and confirm
# it arrives in Jaeger. Datadog verification is advisory (skipped if
# DD_API_KEY/DD_APP_KEY are not set).
#
# This catches configuration issues like OTEL_TRACING_ENABLED not being
# set or the OTel collector not forwarding to Jaeger — problems that
# health checks alone can't detect.
verify_trace_pipeline() {
    log_info "Verifying trace pipeline end-to-end..."

    if [[ -z "${ANTHROPIC_API_KEY:-}" ]]; then
        log_warning "ANTHROPIC_API_KEY not set — skipping trace pipeline verification"
        return
    fi

    # Send a test trace via a quick agent query with tracing enabled.
    # The OTel collector is in-cluster; use port-forward for the OTLP endpoint.
    local otlp_port=4318
    kubectl port-forward -n otel-collector \
        svc/otel-collector-opentelemetry-collector "${otlp_port}:${otlp_port}" &>/dev/null &
    local otlp_pf_pid=$!
    trap "kill ${otlp_pf_pid} 2>/dev/null || true; wait ${otlp_pf_pid} 2>/dev/null || true" EXIT
    sleep 2

    log_info "Sending test trace via agent query..."
    OTEL_TRACING_ENABLED=true \
    OTEL_EXPORTER_TYPE=otlp \
    OTEL_EXPORTER_OTLP_ENDPOINT="http://localhost:${otlp_port}" \
        npx tsx "${REPO_ROOT}/src/index.ts" "what namespaces exist?" &>/dev/null || true

    kill "${otlp_pf_pid}" 2>/dev/null || true
    wait "${otlp_pf_pid}" 2>/dev/null || true
    trap - EXIT

    # Wait for trace propagation
    log_info "Waiting for trace propagation (10s)..."
    sleep 10

    # Query Jaeger API to verify cluster-whisperer service appears
    kubectl port-forward -n jaeger \
        deploy/jaeger 16686:16686 &>/dev/null &
    local jaeger_pf_pid=$!
    trap "kill ${jaeger_pf_pid} 2>/dev/null || true; wait ${jaeger_pf_pid} 2>/dev/null || true" EXIT
    sleep 2

    local jaeger_services
    local trace_verified=false
    local max_attempts=3

    for ((i=1; i<=max_attempts; i++)); do
        jaeger_services=$(curl -sf "http://localhost:16686/api/services" 2>/dev/null || true)
        if echo "${jaeger_services}" | grep -q "cluster-whisperer"; then
            log_success "Trace pipeline verified: cluster-whisperer service found in Jaeger"
            trace_verified=true
            break
        fi
        if [[ $i -lt $max_attempts ]]; then
            log_info "  [attempt ${i}/${max_attempts}] cluster-whisperer not in Jaeger yet, waiting 10s..."
            sleep 10
        fi
    done

    kill "${jaeger_pf_pid}" 2>/dev/null || true
    wait "${jaeger_pf_pid}" 2>/dev/null || true
    trap - EXIT

    if [[ "${trace_verified}" != "true" ]]; then
        log_error "Trace pipeline verification failed: cluster-whisperer not found in Jaeger after 30s"
        log_error "Check: OTEL_TRACING_ENABLED, OTel Collector config, Jaeger OTLP receiver"
        return 1
    fi

    # Advisory: verify Datadog received traces (skip if no keys)
    if [[ -n "${DD_API_KEY:-}" && -n "${DD_APP_KEY:-}" ]]; then
        log_info "Checking Datadog for traces (advisory)..."
        local dd_response
        dd_response=$(curl -sf -X POST "https://api.datadoghq.com/api/v2/spans/events/search" \
            -H "DD-API-KEY: ${DD_API_KEY}" \
            -H "DD-APPLICATION-KEY: ${DD_APP_KEY}" \
            -H "Content-Type: application/json" \
            -d '{"data":{"type":"search_request","attributes":{"filter":{"query":"service:cluster-whisperer","from":"now-5m","to":"now"},"page":{"limit":1}}}}' \
            2>/dev/null || true)

        if echo "${dd_response}" | grep -q '"data"'; then
            log_success "Datadog traces verified (advisory)"
        else
            log_warning "Datadog trace verification inconclusive — check manually"
        fi
    else
        log_info "DD_API_KEY/DD_APP_KEY not set — skipping Datadog trace verification"
    fi
}

# =============================================================================
# Capability Inference Pipeline
# =============================================================================

# Run the capability inference pipeline to populate both Chroma and Qdrant
# vector databases with descriptions of all ~360 CRDs. This makes them
# searchable by meaning (e.g., "PostgreSQL database" finds the platform XRD).
#
# Uses MultiBackendVectorStore: a single pipeline run populates both backends,
# avoiding duplicate LLM inference costs.
#
# Requires ANTHROPIC_API_KEY and VOYAGE_API_KEY in the environment.
# Uses ingress URLs to reach in-cluster Chroma and Qdrant.
# Requires create_ingress_resources to have run first.
run_capability_inference() {
    log_info "Running capability inference pipeline..."
    log_info "This analyzes ~360 CRDs via LLM and stores descriptions in both Chroma and Qdrant."
    log_info "First run takes 10-15 minutes (LLM inference is the bottleneck)."

    if [[ -z "${ANTHROPIC_API_KEY:-}" || -z "${VOYAGE_API_KEY:-}" ]]; then
        log_warning "ANTHROPIC_API_KEY or VOYAGE_API_KEY not set — skipping capability inference"
        log_warning "Export both keys before running setup.sh to populate vector DB"
        return
    fi

    local chroma_url="http://chroma.${BASE_DOMAIN}"
    local qdrant_url="http://qdrant.${BASE_DOMAIN}"
    log_info "Using Chroma at ${chroma_url}, Qdrant at ${qdrant_url}"

    # Run the sync pipeline with both URLs — CLI auto-detects multi-backend mode
    # Strip ANTHROPIC_BASE_URL and ANTHROPIC_CUSTOM_HEADERS so Haiku inference
    # calls go directly to Anthropic, not through the Datadog AI Gateway.
    local sync_exit=0
    env -u ANTHROPIC_CUSTOM_HEADERS -u ANTHROPIC_BASE_URL \
        npx tsx "${REPO_ROOT}/src/index.ts" sync \
        --chroma-url "${chroma_url}" \
        --qdrant-url "${qdrant_url}" || sync_exit=$?

    if [[ $sync_exit -ne 0 ]]; then
        log_error "Capability inference pipeline failed (exit code: ${sync_exit})"
        return 1
    fi

    log_success "Capability inference pipeline complete (both Chroma and Qdrant)"
}

# Verify both Chroma and Qdrant have documents after sync.
# Uses ingress URLs (requires create_ingress_resources to have run).
verify_vector_search() {
    log_info "Verifying vector databases are populated..."

    local chroma_url="http://chroma.${BASE_DOMAIN}"
    local qdrant_url="http://qdrant.${BASE_DOMAIN}"

    # Check Chroma has documents in the capabilities collection
    local chroma_collections
    chroma_collections=$(curl -sf "${chroma_url}/api/v2/collections" 2>/dev/null || true)
    if [[ -n "${chroma_collections}" ]]; then
        log_success "Chroma capabilities collection is populated"
    else
        log_warning "Could not verify Chroma collection — check manually"
    fi

    # Check Qdrant has documents in the capabilities collection
    local qdrant_collections
    qdrant_collections=$(curl -sf "${qdrant_url}/collections/capabilities" 2>/dev/null || true)
    if [[ -n "${qdrant_collections}" ]] && echo "${qdrant_collections}" | grep -q '"points_count"'; then
        local qdrant_count
        qdrant_count=$(echo "${qdrant_collections}" | grep -o '"points_count":[0-9]*' | grep -o '[0-9]*')
        if [[ -n "${qdrant_count}" && "${qdrant_count}" -gt 0 ]]; then
            log_success "Qdrant capabilities collection is populated (${qdrant_count} points)"
        else
            log_warning "Qdrant capabilities collection exists but has 0 points"
        fi
    else
        log_warning "Could not verify Qdrant collection — check manually"
    fi
}

# =============================================================================
# Demo App Deployment
# =============================================================================

# Build the demo app Docker image from demo/app/.
# Returns the image tag to use for kubectl apply.
build_demo_app_image() {
    local demo_app_dir="${REPO_ROOT}/demo/app"

    # Kind runs on the host architecture; GKE runs amd64.
    # Build for the native platform in Kind mode to avoid architecture mismatch.
    local platform_flag=""
    if [[ "${MODE}" == "gcp" ]]; then
        platform_flag="--platform linux/amd64"
    fi

    log_info "Building demo app Docker image..."
    docker build ${platform_flag} -t demo-app:latest "${demo_app_dir}" --quiet
    log_success "Demo app image built"
}

# Deploy the demo app into the cluster. The app intentionally crashes because
# DATABASE_URL points to a non-existent service — producing CrashLoopBackOff
# as the starting scenario for the cluster-whisperer agent.
deploy_demo_app() {
    local demo_app_dir="${REPO_ROOT}/demo/app"

    build_demo_app_image

    if [[ "${MODE}" == "kind" ]]; then
        deploy_demo_app_kind "${demo_app_dir}"
    else
        deploy_demo_app_gke "${demo_app_dir}"
    fi

    wait_for_crashloop
    print_demo_app_diagnostics
}

# Kind: load image directly into the cluster, apply manifests as-is.
deploy_demo_app_kind() {
    local demo_app_dir="$1"

    log_info "Loading demo app image into Kind cluster..."
    kind load docker-image demo-app:latest --name "${CLUSTER_NAME}"
    log_success "Image loaded into Kind"

    log_info "Applying demo app manifests..."
    kubectl apply -f "${demo_app_dir}/k8s/"
    log_success "Demo app deployed (Kind)"
}

# GKE: push image to Artifact Registry, apply manifests with patched image reference.
deploy_demo_app_gke() {
    local demo_app_dir="$1"
    local tagged_image="${AR_IMAGE}:latest"

    # Create Artifact Registry repo if it doesn't exist (idempotent)
    if ! gcloud artifacts repositories describe "${AR_REPO}" \
        --project "${GCP_PROJECT}" \
        --location "${AR_LOCATION}" &>/dev/null 2>&1; then
        log_info "Creating Artifact Registry repository '${AR_REPO}'..."
        gcloud artifacts repositories create "${AR_REPO}" \
            --project "${GCP_PROJECT}" \
            --location "${AR_LOCATION}" \
            --repository-format docker \
            --quiet
        log_success "Artifact Registry repository created"
    fi

    # Configure Docker auth for Artifact Registry
    gcloud auth configure-docker "${AR_LOCATION}-docker.pkg.dev" --quiet 2>/dev/null

    log_info "Pushing demo app image to ${tagged_image}..."
    docker tag demo-app:latest "${tagged_image}"
    docker push "${tagged_image}" --quiet
    log_success "Image pushed to Artifact Registry"

    # Apply manifests with the correct image inline to avoid a double rollout.
    # The base manifests use imagePullPolicy: Never (for Kind). Applying
    # unmodified on GKE creates a pod in ImagePullBackOff, then patching
    # triggers a second rollout. Piping through sed avoids this.
    log_info "Applying demo app manifests..."
    for manifest in "${demo_app_dir}"/k8s/*.yaml; do
        sed \
            -e "s|image: demo-app:latest|image: ${tagged_image}|" \
            -e "s|imagePullPolicy: Never|imagePullPolicy: IfNotPresent|" \
            "${manifest}" \
            | kubectl apply -f -
    done
    log_success "Demo app deployed (GKE)"
}

# Wait for the demo app pod to enter CrashLoopBackOff. This confirms the
# demo scenario is ready: the app crashes because db-service doesn't exist.
wait_for_crashloop() {
    local timeout=120
    local elapsed=0
    local interval=5
    local pod_status=""

    log_info "Waiting for demo app CrashLoopBackOff (timeout: ${timeout}s)..."

    while [[ $elapsed -lt $timeout ]]; do
        pod_status=$(kubectl get pods -l app=demo-app \
            -o jsonpath='{.items[0].status.containerStatuses[0].state.waiting.reason}' 2>/dev/null || true)

        if [[ "${pod_status}" == "CrashLoopBackOff" ]]; then
            log_success "Demo app is in CrashLoopBackOff — demo scenario ready"
            return 0
        fi

        sleep $interval
        elapsed=$((elapsed + interval))
    done

    log_warning "Demo app did not reach CrashLoopBackOff within ${timeout}s (got: ${pod_status:-unknown})"
    log_warning "The pod may still be in early restart cycles — check manually"
    return 0
}

# Print demo app logs and describe output so the user can verify they're
# agent-friendly (single-line error messages, parseable by cluster-whisperer).
print_demo_app_diagnostics() {
    echo ""
    log_info "Demo app diagnostics (verify agent-friendly output):"
    echo ""
    echo "--- kubectl logs ---"
    kubectl logs -l app=demo-app --tail=10 2>/dev/null || true
    echo ""
    echo "--- kubectl describe pod (events) ---"
    kubectl describe pod -l app=demo-app 2>/dev/null | tail -20 || true
    echo ""
}

# =============================================================================
# k8s-vectordb-sync Controller and cluster-whisperer Serve
# =============================================================================

# Build the cluster-whisperer Docker image from the repo root Dockerfile.
build_cluster_whisperer_image() {
    # Kind runs on the host architecture; GKE runs amd64.
    local platform_flag=""
    if [[ "${MODE}" == "gcp" ]]; then
        platform_flag="--platform linux/amd64"
    fi

    log_info "Building cluster-whisperer Docker image..."
    docker build ${platform_flag} -t cluster-whisperer:latest "${REPO_ROOT}" --quiet
    log_success "cluster-whisperer image built"
}

# Deploy cluster-whisperer in serve mode as a pod, so the k8s-vectordb-sync
# controller can push resource changes to it. Needs API keys as K8s secrets
# and access to the in-cluster Chroma instance.
deploy_cluster_whisperer_serve() {
    log_info "Deploying cluster-whisperer serve..."

    build_cluster_whisperer_image

    # Create namespace
    kubectl create namespace cluster-whisperer \
        --dry-run=client -o yaml | kubectl apply -f -

    # Create secret with API keys from the environment
    if [[ -z "${ANTHROPIC_API_KEY:-}" || -z "${VOYAGE_API_KEY:-}" ]]; then
        log_warning "ANTHROPIC_API_KEY or VOYAGE_API_KEY not set — skipping cluster-whisperer serve"
        log_warning "Export ANTHROPIC_API_KEY and VOYAGE_API_KEY before running setup.sh"
        return
    fi

    kubectl create secret generic cluster-whisperer-keys \
        --namespace cluster-whisperer \
        --from-literal=ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY}" \
        --from-literal=VOYAGE_API_KEY="${VOYAGE_API_KEY}" \
        --dry-run=client -o yaml | kubectl apply -f -

    if [[ "${MODE}" == "kind" ]]; then
        # Load image directly into Kind cluster
        log_info "Loading cluster-whisperer image into Kind cluster..."
        kind load docker-image cluster-whisperer:latest --name "${CLUSTER_NAME}"
        log_success "Image loaded into Kind"

        kubectl apply -f "${SCRIPT_DIR}/manifests/cluster-whisperer-serve.yaml"
    else
        # GKE: push to Artifact Registry, patch deployment with registry image
        local tagged_image="${AR_LOCATION}-docker.pkg.dev/${GCP_PROJECT}/${AR_REPO}/cluster-whisperer:latest"

        log_info "Pushing cluster-whisperer image to ${tagged_image}..."
        docker tag cluster-whisperer:latest "${tagged_image}"
        docker push "${tagged_image}" --quiet
        log_success "Image pushed to Artifact Registry"

        # Apply manifest with the correct image inline to avoid a double rollout.
        # The base manifest uses imagePullPolicy: Never (for Kind). Applying it
        # unmodified on GKE creates a pod that immediately enters ImagePullBackOff,
        # and the subsequent patch triggers a second rollout — adding minutes of
        # unnecessary delay while the old pod terminates.
        sed \
            -e "s|image: cluster-whisperer:latest|image: ${tagged_image}|" \
            -e "s|imagePullPolicy: Never|imagePullPolicy: IfNotPresent|" \
            "${SCRIPT_DIR}/manifests/cluster-whisperer-serve.yaml" \
            | kubectl apply -f -
    fi

    wait_for_pods "cluster-whisperer" "app=cluster-whisperer" 600
    log_success "cluster-whisperer serve deployed"
}

# Deploy k8s-vectordb-sync controller. Watches CRD and resource changes,
# pushes updates to cluster-whisperer's HTTP endpoints.
# Requires: wiggitywhitney/k8s-vectordb-sync container image.
deploy_vectordb_sync() {
    log_info "Deploying k8s-vectordb-sync controller..."

    # The chart is in the k8s-vectordb-sync repo; use OCI or git-based install.
    # For now, install from the repo's published chart.
    helm repo add k8s-vectordb-sync https://wiggitywhitney.github.io/k8s-vectordb-sync/ --force-update &>/dev/null 2>&1 || true

    # Check if already installed (idempotency)
    if helm list -n k8s-vectordb-sync 2>/dev/null | grep -q k8s-vectordb-sync; then
        log_success "k8s-vectordb-sync already installed"
        return
    fi

    # If the Helm repo isn't published, fall back to local chart path.
    # The user can clone the repo alongside cluster-whisperer.
    local chart_source="k8s-vectordb-sync/k8s-vectordb-sync"
    local sync_repo_path="${REPO_ROOT}/../k8s-vectordb-sync"
    # helm search repo returns exit 0 even with no results (prints "No results
    # found"), so we must check stdout for actual chart matches.
    local search_results
    search_results=$(helm search repo k8s-vectordb-sync/k8s-vectordb-sync 2>/dev/null || true)
    if ! echo "${search_results}" | grep -q "k8s-vectordb-sync"; then
        if [[ -d "${sync_repo_path}/charts/k8s-vectordb-sync" ]]; then
            chart_source="${sync_repo_path}/charts/k8s-vectordb-sync"
            log_info "Using local chart from ${chart_source}"
        else
            log_warning "k8s-vectordb-sync Helm chart not available"
            log_warning "Clone the repo alongside cluster-whisperer or publish the chart"
            return
        fi
    fi

    # For Kind, load the image locally if available (avoids GHCR pull)
    if [[ "${MODE}" == "kind" ]]; then
        local sync_image="wiggitywhitney/k8s-vectordb-sync:0.1.0"
        if docker image inspect "${sync_image}" &>/dev/null; then
            log_info "Loading k8s-vectordb-sync image into Kind cluster..."
            kind load docker-image "${sync_image}" --name "${CLUSTER_NAME}"
        fi
    fi

    helm install k8s-vectordb-sync "${chart_source}" \
        \
        --namespace k8s-vectordb-sync \
        --create-namespace \
        --values "${SCRIPT_DIR}/helm-values/k8s-vectordb-sync.yaml" \
        --wait --timeout 120s

    log_success "k8s-vectordb-sync controller deployed"
}

# Run instance sync to populate the instances collection in both Chroma and Qdrant.
# Uses the CLI pull-based approach (sync-instances) with multi-backend mode.
# This ensures instances are populated even if the controller isn't deployed.
run_instance_sync() {
    log_info "Running instance sync (populating instances collection in both backends)..."

    local chroma_url="http://chroma.${BASE_DOMAIN}"
    local qdrant_url="http://qdrant.${BASE_DOMAIN}"
    log_info "Using Chroma at ${chroma_url}, Qdrant at ${qdrant_url}"

    # Run sync-instances with both URLs — CLI auto-detects multi-backend mode
    # Strip Datadog AI Gateway vars (same reason as sync above).
    local sync_exit=0
    env -u ANTHROPIC_CUSTOM_HEADERS -u ANTHROPIC_BASE_URL \
        npx tsx "${REPO_ROOT}/src/index.ts" sync-instances \
        --chroma-url "${chroma_url}" \
        --qdrant-url "${qdrant_url}" || sync_exit=$?

    if [[ $sync_exit -ne 0 ]]; then
        log_error "Instance sync failed (exit code: ${sync_exit})"
        return 1
    fi

    log_success "Instance sync complete (both Chroma and Qdrant)"
}

# =============================================================================
# Summary
# =============================================================================

print_summary() {
    local crd_count
    crd_count=$(kubectl get crds --no-headers 2>/dev/null | wc -l | tr -d ' ')

    echo ""
    log_success "=============================================="
    log_success "Demo Cluster Ready (${MODE} mode)"
    log_success "=============================================="
    echo ""
    local demo_app_status
    demo_app_status=$(kubectl get pods -l app=demo-app \
        -o jsonpath='{.items[0].status.containerStatuses[0].state.waiting.reason}' 2>/dev/null || echo "unknown")

    local chroma_status
    chroma_status=$(kubectl get pods -n chroma \
        -o jsonpath='{.items[0].status.phase}' 2>/dev/null || echo "not installed")

    local qdrant_status
    qdrant_status=$(kubectl get pods -n qdrant \
        -o jsonpath='{.items[0].status.phase}' 2>/dev/null || echo "not installed")

    local serve_status
    serve_status=$(kubectl get pods -n cluster-whisperer -l app=cluster-whisperer \
        -o jsonpath='{.items[0].status.phase}' 2>/dev/null || echo "not installed")

    local jaeger_status
    jaeger_status=$(kubectl get pods -n jaeger \
        -o jsonpath='{.items[0].status.phase}' 2>/dev/null || echo "not installed")

    local sync_status
    sync_status=$(kubectl get pods -n k8s-vectordb-sync \
        -o jsonpath='{.items[0].status.phase}' 2>/dev/null || echo "not installed")

    log_info "Mode:           ${MODE}"
    log_info "Cluster:        ${CLUSTER_NAME}"
    log_info "KUBECONFIG:     ${KUBECONFIG_PATH}"
    log_info "CRDs:           ${crd_count}"
    log_info "Demo app:       ${demo_app_status}"
    log_info "Chroma:         ${chroma_status} (chroma-chromadb.chroma:8000)"
    log_info "Qdrant:         ${qdrant_status} (qdrant.qdrant:6333)"
    local otel_collector_status
    otel_collector_status=$(kubectl get pods -n otel-collector \
        -o jsonpath='{.items[0].status.phase}' 2>/dev/null || echo "not installed")

    log_info "Jaeger:         ${jaeger_status} (jaeger.jaeger:16686)"
    log_info "OTel Collector: ${otel_collector_status} (otel-collector-opentelemetry-collector.otel-collector:4318)"
    local ingress_status
    ingress_status=$(kubectl get pods -n ingress-nginx \
        -l app.kubernetes.io/component=controller \
        -o jsonpath='{.items[0].status.phase}' 2>/dev/null || echo "not installed")

    log_info "Ingress NGINX: ${ingress_status}"
    log_info "CW serve:       ${serve_status} (cluster-whisperer.cluster-whisperer:3000)"
    log_info "vectordb-sync:  ${sync_status}"
    echo ""
    if [[ -n "${BASE_DOMAIN}" ]]; then
        echo ""
        log_info "Ingress URLs:"
        log_info "  cluster-whisperer: http://cluster-whisperer.${BASE_DOMAIN}"
        log_info "  Jaeger UI:         http://jaeger.${BASE_DOMAIN}"
        log_info "  Chroma:            http://chroma.${BASE_DOMAIN}"
        log_info "  Qdrant:            http://qdrant.${BASE_DOMAIN}"
        log_info "  OTel Collector:    http://otel.${BASE_DOMAIN}"
        log_info "  Demo App:          http://demo-app.${BASE_DOMAIN}  (502 until DB connects)"
    fi
    echo ""
    log_info "To use this cluster:"
    echo "  export KUBECONFIG=${KUBECONFIG_PATH}"
    echo "  kubectl get crds | wc -l"
    echo "  kubectl get providers"
    echo "  kubectl get pods -l app=demo-app"
    echo "  kubectl get pods -n chroma"
    echo "  kubectl get pods -n qdrant"
    echo "  kubectl get pods -n jaeger"
    echo "  kubectl get pods -n otel-collector"
    echo "  kubectl get pods -n ingress-nginx"
    echo ""
    if [[ "${MODE}" == "kind" ]]; then
        log_info "OTLP endpoint: http://localhost:14318 (HTTP) / localhost:14317 (gRPC)"
    fi
    echo ""
    log_info "For the demo:"
    echo "  source demo/.env"
    echo "  # Then set audience-facing env vars live on stage after each vote"
    echo ""
    log_info "To tear down:"
    echo "  ./demo/cluster/teardown.sh"
    echo ""
}

# =============================================================================
# Main
# =============================================================================

usage() {
    echo "Usage: $0 <kind|gcp> [--verify-only]"
    echo ""
    echo "Modes:"
    echo "  kind   Create a local Kind cluster (~360 CRDs)"
    echo "  gcp    Create a GKE cluster (~360 CRDs)"
    echo ""
    echo "Options:"
    echo "  --verify-only   Skip cluster creation, only run verification steps"
    echo "                  against an existing cluster. Completes in ~2 minutes."
    echo ""
    echo "Environment variables (gcp mode):"
    echo "  GCP_ZONE    Override auto-detected zone (e.g., GCP_ZONE=europe-west1-b $0 gcp)"
    exit 1
}

# Verify that an existing cluster is accessible via kubectl.
# Fails early with a clear message if no cluster exists.
verify_cluster_accessible() {
    log_info "Checking cluster accessibility..."
    if ! kubectl cluster-info &>/dev/null; then
        log_error "No accessible cluster found. Is your KUBECONFIG set correctly?"
        log_error "Run setup without --verify-only to create a cluster first."
        return 1
    fi
    local node_count
    node_count=$(kubectl get nodes --no-headers 2>/dev/null | wc -l | tr -d ' ') || node_count=0
    if [[ $node_count -eq 0 ]]; then
        log_error "Cluster is accessible but has 0 nodes — something is wrong."
        return 1
    fi
    log_success "Cluster accessible (${node_count} nodes)"
}

main() {
    # Validate mode argument
    if [[ $# -lt 1 ]]; then
        usage
    fi

    MODE="$1"
    if [[ "${MODE}" != "kind" && "${MODE}" != "gcp" ]]; then
        log_error "Invalid mode: '${MODE}'"
        usage
    fi

    # Parse optional flags
    local verify_only=false
    shift
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --verify-only)
                verify_only=true
                shift
                ;;
            *)
                log_error "Unknown option: '$1'"
                usage
                ;;
        esac
    done

    if [[ "${verify_only}" == "true" ]]; then
        echo ""
        log_info "Cluster Whisperer Demo Verification (${MODE} mode)"
        log_info "=================================="
        echo ""

        verify_cluster_accessible
        verify_vector_dbs
        verify_observability
        verify_vector_search
        print_summary
        return 0
    fi

    echo ""
    log_info "Cluster Whisperer Demo Setup (${MODE} mode)"
    log_info "============================"
    echo ""

    # Mode-specific prerequisites and cluster creation
    if [[ "${MODE}" == "kind" ]]; then
        check_prerequisites_kind
        create_kind_cluster
    else
        detect_gcp_zone
        check_prerequisites_gcp
        create_gke_cluster
    fi

    install_ingress_controller
    install_crossplane
    install_crossplane_providers
    install_platform_compositions
    install_chroma
    install_qdrant

    # The Chroma/Qdrant installs push the cumulative object count past GKE's
    # control plane resize threshold. The resize starts asynchronously — wait
    # for it and verify API server connectivity before proceeding.
    if [[ "${MODE}" == "gcp" ]]; then
        wait_for_gke_operations
        wait_for_api_server
    fi

    verify_vector_dbs
    install_jaeger
    install_otel_collector
    verify_observability
    verify_trace_pipeline
    deploy_demo_app
    deploy_cluster_whisperer_serve
    create_ingress_resources
    run_capability_inference
    verify_vector_search
    run_instance_sync
    generate_demo_env
    deploy_vectordb_sync
    print_summary
}

main "$@"
