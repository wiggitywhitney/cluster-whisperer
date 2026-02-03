# PRD #19: OpenTelemetry Weaver Schema Validation

## Problem Statement

cluster-whisperer has mature tracing conventions documented in `docs/tracing-conventions.md` (364 lines), covering 20+ span attributes across 4 span types. However, these conventions exist only as prose documentation:

1. **No schema validation**: New attributes can be added without consistent typing, naming, or documentation
2. **Drift risk**: Code can diverge from documentation without detection
3. **No OTel reference validation**: We claim to follow OTel semantic conventions, but have no automated check
4. **Manual documentation**: Keeping docs in sync with implementation requires manual effort

The existing assessment in `docs/opentelemetry-research.md` Section 3 concluded "Weaver is NOT Applicable" because:
- "Constants already exist" from `@opentelemetry/semantic-conventions`
- "Solves enterprise-scale problems"
- "No custom schemas"

**This assessment is now outdated** because:
1. We have custom attributes (`k8s.namespace`, `k8s.output_size_bytes`, `user.question`, `mcp.tool.name`)
2. We have documented conventions that should be machine-validated
3. commit-story-v2 demonstrated a lightweight Weaver pattern that works for small projects
4. The investigate tool will grow, making drift prevention valuable now

## Solution Overview

Implement OpenTelemetry Weaver schema validation following the commit-story-v2 pattern:

```
telemetry/registry/
├── registry_manifest.yaml    # name, version, OTel v1.37.0 dependency
├── attributes.yaml           # attribute groups with refs + custom definitions
└── resolved.json             # output from weaver registry resolve
```

This provides:
- Machine-readable schema as source of truth
- Validation that custom attributes are properly typed
- References to official OTel conventions (gen_ai.*, process.*, error.*)
- Generated documentation from schema

## Success Criteria

- [ ] Schema validates all attributes documented in `docs/tracing-conventions.md`
- [ ] OTel semantic convention references resolve successfully
- [ ] Custom attributes are properly typed and documented
- [ ] `weaver registry resolve` completes without errors
- [ ] npm scripts provide easy validation workflow

---

## Milestones

### Milestone 1: Research and Documentation
**Status**: Not Started

**Objective**: Create research document specific to Weaver in cluster-whisperer context, updating the outdated assessment.

**Deliverables**:
- `docs/weaver-research.md` containing:
  - Current attribute inventory extracted from code (not just docs)
  - OTel conventions to reference (`gen_ai.*`, `process.*`, `error.*`)
  - Custom attributes requiring definition (`k8s.*`, `mcp.*`, `traceloop.*`)
  - Weaver CLI installation and commands
  - Updated rationale for why Weaver is now applicable

**Implementation**:
- [ ] Extract attribute usage from `src/tracing/context-bridge.ts`
- [ ] Extract attribute usage from `src/utils/kubectl.ts`
- [ ] Categorize each attribute as OTel ref or custom
- [ ] Document Weaver CLI workflow
- [ ] Explain changed circumstances since PRD #6

**Success Criteria**:
- Complete inventory of all span attributes used in code
- Each attribute categorized with rationale
- Clear explanation addressing the outdated Section 3 assessment

**References**:
- `docs/tracing-conventions.md` - current conventions
- `docs/opentelemetry-research.md` Section 3 - outdated assessment
- commit-story-v2: `/Users/whitney.lee/Documents/Repositories/commit-story-v2/telemetry/registry/`

---

### Milestone 2: Registry Structure
**Status**: Not Started

**Objective**: Create the base Weaver registry structure with OTel dependency.

**Prerequisite**: Read `docs/weaver-research.md` from Milestone 1

**Deliverables**:
- `telemetry/registry/registry_manifest.yaml`
- `telemetry/registry/attributes.yaml` (placeholder)

**Implementation**:
- [ ] Create `telemetry/registry/` directory
- [ ] Create `registry_manifest.yaml` pinning OTel v1.37.0
- [ ] Create placeholder `attributes.yaml`
- [ ] Verify `weaver registry check` passes

**registry_manifest.yaml**:
```yaml
name: cluster_whisperer
description: OpenTelemetry semantic conventions for cluster-whisperer
semconv_version: 0.1.0
dependencies:
  - name: otel
    registry_path: https://github.com/open-telemetry/semantic-conventions/archive/refs/tags/v1.37.0.zip[model]
```

**Success Criteria**:
- Directory structure matches commit-story-v2 pattern
- `weaver registry check` passes

---

### Milestone 3: Attribute Definitions
**Status**: Not Started

**Objective**: Define all attribute groups in `attributes.yaml`.

**Prerequisite**: Read `docs/weaver-research.md` from Milestone 1

**Deliverables**:
- Complete `telemetry/registry/attributes.yaml`

**Attribute Groups**:

1. **`registry.cluster_whisperer.root`** - Root span attributes
   - `service.operation` (string)
   - `traceloop.span.kind` (enum: workflow, tool)
   - `traceloop.entity.name` (string)
   - `user.question` (string, content-gated)
   - `traceloop.entity.input` (string, content-gated)
   - `traceloop.entity.output` (string, content-gated)

2. **`registry.cluster_whisperer.mcp`** - MCP-specific attributes
   - `mcp.tool.name` (string)
   - `ref: gen_ai.operation.name`
   - `ref: gen_ai.tool.name`
   - `ref: gen_ai.tool.type`
   - `ref: gen_ai.tool.call.id`

3. **`registry.cluster_whisperer.subprocess`** - kubectl subprocess attributes
   - `ref: process.executable.name`
   - `ref: process.command_args`
   - `ref: process.exit.code`
   - `ref: error.type`
   - `k8s.namespace` (string, custom)
   - `k8s.output_size_bytes` (int, custom)

**Implementation**:
- [ ] Define root span attribute group
- [ ] Define MCP attribute group with GenAI refs
- [ ] Define subprocess attribute group with process refs
- [ ] Add custom k8s attributes
- [ ] Verify `weaver registry resolve` succeeds

**Success Criteria**:
- All attributes from `docs/tracing-conventions.md` represented
- `weaver registry resolve` completes without errors
- References to OTel conventions resolve correctly

---

### Milestone 4: Validation Integration
**Status**: Not Started

**Objective**: Add npm scripts for Weaver workflow and generate resolved output.

**Prerequisite**: Milestones 2-3 complete

**Deliverables**:
- npm scripts in `package.json`
- `telemetry/registry/resolved.json`

**Implementation**:
- [ ] Add `telemetry:check` script
- [ ] Add `telemetry:resolve` script
- [ ] Generate `resolved.json`
- [ ] Document Weaver installation in README or CLAUDE.md

**npm scripts**:
```json
{
  "telemetry:check": "weaver registry check telemetry/registry",
  "telemetry:resolve": "weaver registry resolve telemetry/registry -f json -o telemetry/registry/resolved.json"
}
```

**Success Criteria**:
- `npm run telemetry:check` passes
- `npm run telemetry:resolve` produces valid JSON
- `resolved.json` committed to repo

---

### Milestone 5: Documentation Update
**Status**: Not Started

**Objective**: Update existing docs to reference schema as source of truth.

**Prerequisite**: Milestone 4 complete

**Deliverables**:
- Updated `docs/tracing-conventions.md`
- Updated `docs/opentelemetry-research.md` Section 3

**Implementation**:
- [ ] Add note to `tracing-conventions.md` about Weaver schema
- [ ] Update Section 3 assessment in `opentelemetry-research.md`
- [ ] Add Weaver workflow to CLAUDE.md

**Success Criteria**:
- Documentation reflects schema as source of truth
- Outdated "NOT Applicable" assessment corrected

---

## Progress Log

### 2026-02-03: PRD Created

**Context**: Following successful PRD #16 (high-level investigate MCP tool), the tracing infrastructure is maturing. As the investigate tool grows, schema validation becomes valuable for maintaining consistency.

**Key decisions**:
1. Follow commit-story-v2 pattern for lightweight Weaver adoption
2. Research phase as Milestone 1 to create reference documentation
3. Each milestone references research docs for context
4. CI integration deferred until schema is stable

**References**:
- commit-story-v2 Weaver implementation: `/Users/whitney.lee/Documents/Repositories/commit-story-v2/telemetry/registry/`
- commit-story-v2 research: `/Users/whitney.lee/Documents/Repositories/commit-story-v2/docs/research/weaver-schema-research.md`

---

## Technical Context

### Current Attribute Inventory

**Root Spans** (`src/tracing/context-bridge.ts`):

| Attribute | CLI Mode | MCP Mode | OTel Ref? |
|-----------|----------|----------|-----------|
| `service.operation` | Yes | Yes | Custom |
| `traceloop.span.kind` | Yes | Yes | Custom (OpenLLMetry) |
| `traceloop.entity.name` | Yes | Yes | Custom (OpenLLMetry) |
| `user.question` | Content-gated | No | Custom |
| `traceloop.entity.input` | Content-gated | Content-gated | Custom (OpenLLMetry) |
| `traceloop.entity.output` | Content-gated | Content-gated | Custom (OpenLLMetry) |
| `mcp.tool.name` | No | Yes | Custom |
| `gen_ai.operation.name` | No | Yes | OTel GenAI |
| `gen_ai.tool.name` | No | Yes | OTel GenAI |
| `gen_ai.tool.type` | No | Yes | OTel GenAI |
| `gen_ai.tool.call.id` | No | Yes | OTel GenAI |

**Subprocess Spans** (`src/utils/kubectl.ts`):

| Attribute | Always | Conditional | OTel Ref? |
|-----------|--------|-------------|-----------|
| `process.executable.name` | Yes | | OTel Process |
| `process.command_args` | Yes | | OTel Process |
| `process.exit.code` | Yes | | OTel Process |
| `error.type` | | On error | OTel Error |
| `k8s.namespace` | | If -n flag | Custom |
| `k8s.output_size_bytes` | | On success | Custom |

### Weaver CLI Commands

```bash
# Install Weaver (requires Rust)
cargo install weaver

# Validate registry
weaver registry check telemetry/registry

# Resolve references to JSON
weaver registry resolve telemetry/registry -f json -o telemetry/registry/resolved.json
```

---

## References

- [OpenTelemetry Weaver](https://github.com/open-telemetry/weaver)
- [OTel Semantic Conventions v1.37.0](https://github.com/open-telemetry/semantic-conventions/tree/v1.37.0)
- commit-story-v2 pattern: See `telemetry/registry/` in that repo
- Existing conventions: `docs/tracing-conventions.md`
- Outdated assessment: `docs/opentelemetry-research.md` Section 3
