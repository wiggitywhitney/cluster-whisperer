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
1. We have custom attributes (`cluster_whisperer.k8s.namespace`, `cluster_whisperer.k8s.output_size_bytes`, `cluster_whisperer.user.question`, `cluster_whisperer.mcp.tool.name`)
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

- [x] Schema validates all attributes documented in `docs/tracing-conventions.md`
- [x] OTel semantic convention references resolve successfully
- [x] Custom attributes are properly typed and documented
- [x] `weaver registry resolve` completes without errors
- [x] npm scripts provide easy validation workflow

---

## Milestones

### Milestone 1: Research and Documentation
**Status**: Complete ✅

**Objective**: Create research document specific to Weaver in cluster-whisperer context, updating the outdated assessment.

**Deliverables**:
- `docs/weaver-research.md` containing:
  - Current attribute inventory extracted from code (not just docs)
  - OTel conventions to reference (`gen_ai.*`, `process.*`, `error.*`)
  - Custom attributes requiring definition (`cluster_whisperer.k8s.*`, `cluster_whisperer.mcp.*`, `traceloop.*`)
  - Weaver CLI installation and commands
  - Updated rationale for why Weaver is now applicable

**Implementation**:
- [x] Extract attribute usage from `src/tracing/context-bridge.ts`
- [x] Extract attribute usage from `src/utils/kubectl.ts`
- [x] Categorize each attribute as OTel ref or custom
- [x] Document Weaver CLI workflow
- [x] Explain changed circumstances since PRD #6

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
**Status**: Complete ✅

**Objective**: Create the base Weaver registry structure with OTel dependency.

**Prerequisite**: Read `docs/weaver-research.md` from Milestone 1

**Deliverables**:
- `telemetry/registry/registry_manifest.yaml`
- `telemetry/registry/attributes.yaml`

**Implementation**:
- [x] Create `telemetry/registry/` directory
- [x] Create `registry_manifest.yaml` pinning OTel v1.37.0
- [x] Create `attributes.yaml`
- [x] Verify `weaver registry check` passes

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
**Status**: Complete ✅

**Objective**: Define all attribute groups in `attributes.yaml`.

**Prerequisite**: Read `docs/weaver-research.md` from Milestone 1

**Deliverables**:
- Complete `telemetry/registry/attributes.yaml`

**Attribute Groups**:

1. **`registry.cluster_whisperer.root`** - Root span attributes
   - `cluster_whisperer.service.operation` (string)
   - `cluster_whisperer.user.question` (string, content-gated)

2. **`registry.cluster_whisperer.mcp`** - MCP-specific attributes
   - `cluster_whisperer.mcp.tool.name` (string)
   - `ref: gen_ai.operation.name`
   - `ref: gen_ai.tool.name`
   - `ref: gen_ai.tool.type`
   - `ref: gen_ai.tool.call.id`

3. **`registry.cluster_whisperer.subprocess`** - kubectl subprocess attributes
   - `ref: process.executable.name`
   - `ref: process.command_args`
   - `ref: process.exit.code`
   - `ref: error.type`
   - `cluster_whisperer.k8s.namespace` (string, custom)
   - `cluster_whisperer.k8s.output_size_bytes` (int, custom)

4. **`registry.cluster_whisperer.openllmetry`** - OpenLLMetry/Traceloop attributes
   - `traceloop.span.kind` (enum: workflow, tool, task)
   - `traceloop.entity.name` (string)
   - `traceloop.entity.input` (string, content-gated)
   - `traceloop.entity.output` (string, content-gated)

**Implementation**:
- [x] Define root span attribute group
- [x] Define MCP attribute group with GenAI refs
- [x] Define subprocess attribute group with process refs
- [x] Add custom k8s attributes
- [x] Verify `weaver registry resolve` succeeds

**Success Criteria**:
- All attributes from `docs/tracing-conventions.md` represented
- `weaver registry resolve` completes without errors
- References to OTel conventions resolve correctly

---

### Milestone 4: Validation Integration
**Status**: Complete ✅

**Objective**: Add npm scripts for Weaver workflow and generate resolved output.

**Prerequisite**: Milestones 2-3 complete ✅

**Deliverables**:
- npm scripts in `package.json`
- `telemetry/registry/resolved.json`

**Implementation**:
- [x] Add `telemetry:check` script
- [x] Add `telemetry:resolve` script
- [x] Generate `resolved.json`
- [x] Document Weaver installation in CLAUDE.md

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
**Status**: Complete ✅

**Objective**: Update existing docs to reference schema as source of truth.

**Prerequisite**: Milestone 4 complete ✅

**Deliverables**:
- Updated `docs/tracing-conventions.md`
- Updated `docs/opentelemetry-research.md` Section 3

**Implementation**:
- [x] Add note to `tracing-conventions.md` about Weaver schema
- [x] Update Section 3 assessment in `opentelemetry-research.md`
- [x] Add Weaver workflow to CLAUDE.md

**Success Criteria**:
- Documentation reflects schema as source of truth
- Outdated "NOT Applicable" assessment corrected

---

## Progress Log

### 2026-02-05: Milestone 5 Complete - PRD #19 Done

**Completed**: Final documentation update

**Deliverable**:
- Updated `docs/opentelemetry-research.md` Section 3 to reflect current Weaver usage
- Reframed original "NOT Applicable" assessment as historical context (January 2026)
- Added "Updated Assessment (February 2026): Now Applicable" with current implementation details
- Added revision note in Section 6 pointing to PRD #19

**All milestones complete. All success criteria met.**

---

### 2026-02-05: Milestone 4 Complete, Milestone 5 Partial

**Completed**: Validation Integration and partial Documentation Update

**Milestone 4 Deliverables**:
- Added `telemetry:check` npm script (validates registry structure)
- Added `telemetry:resolve` npm script (generates resolved.json)
- Added Weaver documentation to CLAUDE.md (installation, commands, registry structure)

**Milestone 5 Partial**:
- Slimmed `docs/tracing-conventions.md` from 366 to 319 lines
- Removed redundant attribute tables (now in Weaver schema)
- Added callout pointing to schema as source of truth for attributes
- Preserved architectural content: context propagation, error handling, security rationale

**Remaining**: Update Section 3 in `opentelemetry-research.md` to correct outdated "NOT Applicable" assessment.

---

### 2026-02-05: Milestones 2 & 3 Complete

**Completed**: Registry Structure and Attribute Definitions

**Deliverables**:
- Created `telemetry/registry/registry_manifest.yaml` with OTel v1.37.0 dependency
- Created `telemetry/registry/attributes.yaml` with 4 attribute groups (17 total attributes)
- Generated `telemetry/registry/resolved.json` with expanded OTel references

**Attribute Groups Created**:
| Group | Custom | OTel Refs | Total |
|-------|--------|-----------|-------|
| `registry.cluster_whisperer.root` | 2 | 0 | 2 |
| `registry.cluster_whisperer.mcp` | 1 | 4 | 5 |
| `registry.cluster_whisperer.subprocess` | 2 | 4 | 6 |
| `registry.cluster_whisperer.openllmetry` | 4 | 0 | 4 |

**Validation**:
- `weaver registry check` passes with no warnings
- `weaver registry resolve` succeeds, all OTel refs (gen_ai.*, process.*, error.*) expand correctly

**Key insight**: Combined Milestones 2 and 3 because Weaver requires at least one valid attribute to pass `registry check` - empty placeholders aren't valid schema.

---

### 2026-02-05: Milestone 1 Complete

**Completed**: Research and Documentation milestone

**Deliverables**:
- Created `docs/weaver-research.md` with complete attribute inventory
- Extracted 17 attributes from code (8 OTel refs, 4 OpenLLMetry, 5 custom)
- Documented Weaver CLI workflow and installation
- Explained why Weaver is now applicable (addressing outdated Section 3 assessment)

**Additional work**:
- Updated code to use `cluster_whisperer.*` namespaced attributes (industry standard compliance)
- Updated `docs/tracing-conventions.md` to reflect namespaced attribute names

**Key insight**: Custom attributes should use project namespace to avoid conflicts with future OTel semconvs.

---

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

**Note**: Custom attributes use `cluster_whisperer.*` namespace per OTel conventions. See `docs/weaver-research.md` for full inventory and categorization.

**Root Spans** (`src/tracing/context-bridge.ts`):

| Attribute | CLI Mode | MCP Mode | OTel Ref? |
|-----------|----------|----------|-----------|
| `cluster_whisperer.service.operation` | Yes | Yes | Custom |
| `traceloop.span.kind` | Yes | Yes | Custom (OpenLLMetry) |
| `traceloop.entity.name` | Yes | Yes | Custom (OpenLLMetry) |
| `cluster_whisperer.user.question` | Content-gated | No | Custom |
| `traceloop.entity.input` | Content-gated | Content-gated | Custom (OpenLLMetry) |
| `traceloop.entity.output` | Content-gated | Content-gated | Custom (OpenLLMetry) |
| `cluster_whisperer.mcp.tool.name` | No | Yes | Custom |
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
| `cluster_whisperer.k8s.namespace` | | If -n flag | Custom |
| `cluster_whisperer.k8s.output_size_bytes` | | On success | Custom |

### Weaver CLI Commands

```bash
# Install Weaver (requires Rust)
cargo install weaver

# Validate registry
weaver registry check -r telemetry/registry

# Resolve references to JSON
weaver registry resolve -r telemetry/registry -f json -o telemetry/registry/resolved.json
```

---

## References

- [OpenTelemetry Weaver](https://github.com/open-telemetry/weaver)
- [OTel Semantic Conventions v1.37.0](https://github.com/open-telemetry/semantic-conventions/tree/v1.37.0)
- commit-story-v2 pattern: See `telemetry/registry/` in that repo
- Existing conventions: `docs/tracing-conventions.md`
- Outdated assessment: `docs/opentelemetry-research.md` Section 3
