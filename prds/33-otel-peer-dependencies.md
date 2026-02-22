# PRD #33: OTel Peer Dependencies for Distribution

**Status**: Active
**Created**: 2026-02-21
**GitHub Issue**: [#33](https://github.com/wiggitywhitney/cluster-whisperer/issues/33)

---

## Problem Statement

All OpenTelemetry packages are direct `dependencies` in package.json. This violates official OTel packaging guidelines and causes problems when cluster-whisperer is consumed as a distributed package:

1. **Duplicate API instances**: Multiple copies of `@opentelemetry/api` in the dependency tree cause silent trace loss via no-op fallbacks. The OTel API uses a global singleton with Symbol-based keys — duplicate versions get no-op implementations without any error.
2. **Forced telemetry overhead**: Consumers who don't want telemetry still get 6 OTel SDK packages and the full Traceloop SDK installed.
3. **Version conflicts**: `@traceloop/node-server-sdk` already declares `@opentelemetry/api` as both a direct dep AND peer dep. Adding cluster-whisperer's own direct dep creates a three-way deduplication problem.

This matters now because we have both a CLI binary and an MCP server (`bin` entries) that are intended for distribution via npm.

## Solution

Move `@opentelemetry/api` to a **required peer dependency** and all SDK/instrumentation packages to **optional peer dependencies** with graceful degradation via dynamic imports.

The OTel API is designed to return no-op implementations when no SDK is configured. This means:
- Consumers who install only `@opentelemetry/api` (required peer) get zero-overhead no-ops for all tracing calls
- Consumers who also install the SDK packages get full telemetry
- No code changes needed in files that only use `@opentelemetry/api` (6 of 8 OTel-touching files)

### Why Required Peer for the API

The API package is ~50KB and designed to be present even when no SDK is configured. All tracing calls (span creation, attribute setting, status codes) safely no-op. Making it a required peer keeps 6 files with static imports unchanged and avoids a complex refactor with dynamic imports and try/catch in every file.

---

## Success Criteria

- [ ] `@opentelemetry/api` is a required `peerDependency`
- [ ] All OTel SDK packages are optional peer dependencies via `peerDependenciesMeta`
- [ ] `@traceloop/node-server-sdk` is an optional peer dependency
- [ ] Package works without SDK packages installed (graceful no-op)
- [ ] Package works with SDK packages installed (full telemetry)
- [ ] Telemetry verified in Datadog before and after refactor
- [ ] No direct OTel packages remain in `dependencies`

## Milestones

- [x] **M1**: Baseline Telemetry Verification
  - Run cluster-whisperer with `OTEL_TRACING_ENABLED=true` against a live cluster
  - Use Datadog MCP tools to query APM spans and verify the current trace hierarchy
  - Document the expected span structure: root span → anthropic.chat → tool spans → kubectl spans
  - Capture baseline span attributes (GenAI semconv, process semconv, custom attributes)
  - This establishes the "before" snapshot that M5 will verify against

- [x] **M2**: Update package.json Dependency Declarations
  - Move `@opentelemetry/api` from `dependencies` to `peerDependencies` (required, `^1.9.0`)
  - Move all OTel SDK packages to `peerDependencies` with `peerDependenciesMeta: { optional: true }`
  - Move `@traceloop/node-server-sdk` to `peerDependencies` with `peerDependenciesMeta: { optional: true }`
  - Keep `@opentelemetry/semantic-conventions` as an optional peer dep (not transitively guaranteed by the API)
  - Add `"engines": { "node": ">=18", "npm": ">=7" }` to package.json (peer dep auto-install requires npm 7+)
  - Run `npm install` and verify the project still builds

- [ ] **M3**: Dynamic Imports for Optional Packages
  - In `src/tracing/index.ts`: convert static imports of SDK and Traceloop to dynamic `require()` wrapped in try/catch
  - In `src/tracing/tool-definitions-processor.ts`: wrap SpanProcessor import in try/catch (already uses lazy require)
  - When optional packages are missing, tracing initialization is skipped entirely
  - When optional packages are present and `OTEL_TRACING_ENABLED=true`, behavior is identical to today
  - Static imports of `@opentelemetry/api` in other files remain unchanged (required peer)

- [ ] **M4**: Graceful Degradation Verification
  - Temporarily uninstall all optional OTel packages
  - Verify CLI starts and runs an investigation successfully (no crashes, no errors)
  - Verify MCP server starts and handles requests successfully
  - Verify `OTEL_TRACING_ENABLED=true` with missing SDK logs a warning but doesn't crash
  - Re-install optional packages and verify telemetry resumes

- [ ] **M5**: Post-Refactor Telemetry Verification
  - Run the same investigation as M1 with `OTEL_TRACING_ENABLED=true`
  - Use the same Datadog MCP queries from M1 to verify traces are identical
  - Compare span hierarchy, attributes, and parent-child relationships
  - Verify no regressions in trace completeness or attribute coverage

- [ ] **M6**: Tests and Documentation
  - Write unit tests for the dynamic import fallback behavior (tracing module loads without SDK)
  - Write integration test that verifies tracing no-ops when SDK is absent
  - Write integration test that verifies tracing works when SDK is present
  - Update `docs/opentelemetry.md` with consumer installation instructions (required vs optional deps)
  - Update README if it references OTel setup

## Technical Approach

### Target package.json Structure

```json
"dependencies": {
  "@langchain/anthropic": "^0.3.14",
  "@langchain/core": "^0.3.27",
  "@langchain/langgraph": "^0.2.42",
  "@modelcontextprotocol/sdk": "^1.25.3",
  "chromadb": "^3.3.0",
  "commander": "^13.0.0",
  "voyageai": "^0.1.0",
  "zod": "3.25.67"
},
"peerDependencies": {
  "@opentelemetry/api": "^1.9.0",
  "@opentelemetry/exporter-trace-otlp-proto": "^0.211.0",
  "@opentelemetry/resources": "^2.5.0",
  "@opentelemetry/sdk-node": "^0.211.0",
  "@opentelemetry/sdk-trace-node": "^2.5.0",
  "@opentelemetry/semantic-conventions": "^1.39.0",
  "@traceloop/node-server-sdk": "~0.22.6"
},
"peerDependenciesMeta": {
  "@opentelemetry/exporter-trace-otlp-proto": { "optional": true },
  "@opentelemetry/resources": { "optional": true },
  "@opentelemetry/sdk-node": { "optional": true },
  "@opentelemetry/sdk-trace-node": { "optional": true },
  "@opentelemetry/semantic-conventions": { "optional": true },
  "@traceloop/node-server-sdk": { "optional": true }
},
"engines": {
  "node": ">=18",
  "npm": ">=7"
}
```

> **Note**: All peer dependency packages are also listed in `devDependencies` to ensure they're available during local development. npm does not auto-install optional peers for the root project.

### Files That Change

| File | Change | Why |
|------|--------|-----|
| `package.json` | Move deps to peer/optionalPeer | Core of the refactor |
| `src/tracing/index.ts` | Static imports → dynamic require() with try/catch for SDK + traceloop | These are the only SDK consumers |
| `src/tracing/tool-definitions-processor.ts` | Wrap SpanProcessor import in try/catch | Extends SDK class |

### Files That Don't Change

| File | Why |
|------|-----|
| `src/tracing/tool-tracing.ts` | Only imports from `@opentelemetry/api` (required peer) |
| `src/tracing/context-bridge.ts` | Only imports from `@opentelemetry/api` (required peer) |
| `src/utils/kubectl.ts` | Only imports `SpanKind`, `SpanStatusCode` from `@opentelemetry/api` |
| `src/tools/langchain/index.ts` | Uses `withToolTracing` (re-exported from tracing module) |
| `src/index.ts` | Imports `./tracing` — tracing module handles degradation internally |
| `src/mcp-server.ts` | Same as index.ts |

### Dynamic Import Pattern

```typescript
// Before (static, crashes if missing):
import * as traceloop from "@traceloop/node-server-sdk";
import { ConsoleSpanExporter } from "@opentelemetry/sdk-trace-node";

// After (dynamic, graceful degradation):
let traceloop: typeof import("@traceloop/node-server-sdk") | null = null;
try {
  traceloop = require("@traceloop/node-server-sdk");
} catch {
  // SDK not installed — tracing will be no-op
}
```

### npm Behavior

- **Requires npm 7+**: Peer dep auto-installation was introduced in npm 7. The `engines` field in package.json enforces this.
- **npm 7+**: Auto-installs required peer deps (`@opentelemetry/api`). Does NOT auto-install optional peers (SDK packages) when `peerDependenciesMeta` marks them `{ "optional": true }`. If `peerDependenciesMeta` is missing from the manifest, npm may attempt to auto-install all peers — so the meta field is required, not decorative.
- **Consumer who wants telemetry**: `npm install @opentelemetry/sdk-trace-node @opentelemetry/exporter-trace-otlp-proto @traceloop/node-server-sdk`
- **Consumer who doesn't want telemetry**: Nothing extra needed. API installs automatically, returns no-ops.
- **npm 6 and earlier**: Peer deps are not auto-installed. Consumers get a warning but must install manually. The `engines` field prevents silent breakage.

## Dependencies

- **PRD #6** (OpenTelemetry Instrumentation) — the instrumentation this PRD refactors
- **PRD #8** (Datadog Observability) — Datadog integration used for M1/M5 verification
- Live Kubernetes cluster for test investigations
- Datadog Agent with OTLP receiver for trace verification

## Out of Scope

- Changing the tracing architecture or span hierarchy
- Adding new instrumentation or attributes
- Migrating away from `@traceloop/node-server-sdk`
- Filing upstream issues against traceloop for their dependency violations
- Making `@opentelemetry/api` itself optional (decided: required peer)

---

## Design Decisions

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-02-21 | `@opentelemetry/api` as required (not optional) peer | API is ~50KB, returns no-ops by design. Making it required avoids dynamic imports in 6 files. |
| 2026-02-21 | Use `peerDependenciesMeta` with `optional: true` for SDK packages | npm 7+ does not auto-install optional peers. Consumers choose whether to install telemetry. |
| 2026-02-21 | Datadog MCP queries for before/after verification | Real trace comparison is more reliable than unit testing trace output. Validates the full pipeline. |
| 2026-02-21 | Mirror all peer deps in `devDependencies` for local development | npm does not auto-install optional peers for the root project. `devDependencies` ensures packages are available during development while `peerDependencies` controls the consumer install experience. |

---

## Progress Log

| Date | Milestone | Notes |
|------|-----------|-------|
| 2026-02-21 | M1 complete | Baseline traces captured from 2026-02-19 Datadog APM data. Two reference traces documented with full span hierarchy, attributes by span type, and M5 verification checklist. See `docs/research/33-otel-baseline-traces.md`. |
| 2026-02-21 | M2 complete | All 7 OTel packages moved from `dependencies` to `peerDependencies`/`peerDependenciesMeta`. Added `engines` field. All packages mirrored in `devDependencies` for local development. Build passes, 146 tests pass. |
