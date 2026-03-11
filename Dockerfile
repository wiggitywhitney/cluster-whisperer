# ABOUTME: Container image for cluster-whisperer serve mode.
# ABOUTME: Used by the demo cluster setup to run the HTTP server in-cluster.

# Build stage: compile TypeScript to JavaScript
FROM node:22-slim AS builder

WORKDIR /app

# Copy package files first for layer caching
COPY package.json package-lock.json ./
RUN npm ci

# Copy source and build
COPY tsconfig.json ./
COPY src/ src/
COPY prompts/ prompts/
RUN npm run build

# Production stage: minimal image with only runtime dependencies
FROM node:22-slim

# kubectl is needed for the capability inference and instance sync pipelines
# (kubectl api-resources, kubectl explain, kubectl get)
RUN apt-get update && apt-get install -y --no-install-recommends curl \
    && curl -LO "https://dl.k8s.io/release/$(curl -Ls https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl" \
    && install -o root -g root -m 0755 kubectl /usr/local/bin/kubectl \
    && rm kubectl \
    && apt-get remove -y curl && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist/ dist/
COPY prompts/ prompts/

EXPOSE 3000

# Default to serve mode; override args in K8s manifests
ENTRYPOINT ["node", "dist/index.js"]
CMD ["serve"]
