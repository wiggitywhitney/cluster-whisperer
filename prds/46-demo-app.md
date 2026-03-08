# PRD #46: Demo App for Choose Your Own Adventure Talk

**Status**: Not Started
**Priority**: High
**Dependencies**: None
**Branch**: `feature/prd-46-demo-app`

## Problem

The KubeCon "Choose Your Own Adventure" demo needs an app that is visibly broken in a
Kubernetes cluster because its database doesn't exist. The demo flow (documented in
`docs/choose-your-adventure-demo.md`) starts with this broken app — the agent
investigates why it's failing, discovers the missing database, and eventually deploys one.

The app must produce clear, recognizable error messages in `kubectl logs` and `kubectl
describe` output so the agent (and the audience watching the agent think) can follow the
investigation.

## Solution

Build a minimal Hono web server in `demo/app/` that:
- Requires a `DATABASE_URL` environment variable pointing to a PostgreSQL database
- On startup, attempts to connect to the database
- If the connection fails, crashes with a clear error message (producing CrashLoopBackOff)
- If the connection succeeds, serves HTTP responses confirming connectivity
- Ships with a Dockerfile and Kubernetes manifests (Deployment + Service)

The app is a prop — it exists to be broken and then fixed during the demo. Keep it
dead simple.

## Success Criteria

- App deployed to a Kind cluster without a database enters CrashLoopBackOff within seconds
- `kubectl logs` shows a clear error: something like `Error: Cannot connect to database at postgres://...`
- `kubectl describe pod` shows restart count incrementing and CrashLoopBackOff status
- When a PostgreSQL database is available and `DATABASE_URL` points to it, the app starts and serves HTTP traffic
- Container image builds successfully with Docker
- Kubernetes manifests are valid and can be applied with `kubectl apply -f`

## Non-Goals

- Production readiness (no health checks beyond basic liveness, no graceful shutdown, no metrics)
- Database migrations or schema management
- Authentication or authorization
- Complex business logic — this is a prop

## Milestones

### M1: App Implementation
- [ ] Hono web server with `DATABASE_URL` connection logic
- [ ] Clear, agent-friendly error messages on connection failure
- [ ] `GET /` returns connection status when database is available
- [ ] `GET /healthz` liveness probe (returns 200 if process is running, independent of DB)

### M2: Container Image
- [ ] Dockerfile (multi-stage build, small image)
- [ ] Builds and runs locally with `docker build` and `docker run`
- [ ] Verified: crashes without `DATABASE_URL`, runs with it

### M3: Kubernetes Manifests
- [ ] Deployment manifest with `DATABASE_URL` env var (pointing to a service that doesn't exist)
- [ ] Service manifest exposing the app
- [ ] Verified: deploys to Kind cluster, enters CrashLoopBackOff
- [ ] Verified: `kubectl logs`, `kubectl describe` output is clear and agent-friendly

### M4: Agent Investigation Test
- [ ] Deploy app to a Kind cluster
- [ ] Run cluster-whisperer agent against it: "Why is my app broken?"
- [ ] Verify the agent can diagnose the missing database from kubectl output
- [ ] Document the expected agent investigation flow

### M5: Documentation
- [ ] Update README using `/write-docs` to document the demo app and its role in the demo flow

## Technical Design

### App Structure

```text
demo/app/
├── src/
│   └── index.ts          # Hono server with DB connection check
├── Dockerfile
├── package.json
├── tsconfig.json
└── k8s/
    ├── deployment.yaml   # Deployment with DATABASE_URL env var
    └── service.yaml      # ClusterIP service
```

### Database Connection Behavior

On startup, the app attempts to connect to `DATABASE_URL`:
- If `DATABASE_URL` is not set: crash with `Error: DATABASE_URL environment variable is required`
- If connection fails: crash with `Error: Cannot connect to database at <url> - <pg error message>`
- If connection succeeds: start HTTP server

The crash must be immediate (within 1-2 seconds of startup) so the pod enters
CrashLoopBackOff quickly. No retry logic — fail fast and let Kubernetes restart.

### Error Message Design

Error messages are written for the agent to parse. They should be:
- Single-line (easy to extract from `kubectl logs`)
- Include the word "database" (so the agent connects it to the DATABASE_URL concept)
- Include the connection target (so the agent knows what service is missing)

Example:
```text
[demo-app] Starting server...
[demo-app] Connecting to database at postgres://db-service:5432/myapp...
[demo-app] FATAL: Cannot connect to database at postgres://db-service:5432/myapp - Connection refused (ECONNREFUSED)
[demo-app] Exiting with code 1
```

### Kubernetes Manifests

The Deployment manifest should set `DATABASE_URL` to a service that doesn't exist in
the cluster (e.g., `postgres://db-service:5432/myapp`). This is intentional — the
missing database is the scenario the demo investigates.

### Dependencies

Minimal:
- `hono` — HTTP server (consistent with cluster-whisperer's stack)
- `pg` or `postgres` — PostgreSQL client (only needs to attempt a connection)

## Decision Log

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-03-07 | Hono over Express | Consistent with cluster-whisperer's existing stack |
| 2026-03-07 | Crash immediately, no retries | Want fast CrashLoopBackOff for demo pacing |
| 2026-03-07 | Live in demo/app/ not separate repo | It's a prop for this talk, not a standalone project |
| 2026-03-07 | PostgreSQL specifically | The demo deploys a PostgreSQL database via Crossplane Composition as the resolution |
