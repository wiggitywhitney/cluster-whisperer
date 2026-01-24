# PRD #6: OpenTelemetry Instrumentation

**Status**: Not Started
**Created**: 2026-01-24
**GitHub Issue**: [#6](https://github.com/wiggitywhitney/cluster-whisperer/issues/6)

---

## Problem Statement

When the agent investigates a cluster, there's no visibility into what's happening internally. We can't see:
- Which tools were called and in what order
- How long each operation took
- Where failures occurred
- The full trace of an investigation

This matters for debugging, optimization, and demonstrating LLM observability concepts at KubeCon.

## Solution

Instrument the agent with OpenTelemetry to emit traces. This is backend-agnostic - traces can be sent to Jaeger, Datadog, or any OTel-compatible collector.

### Two Types of Spans (per Viktor's guidance)

1. **MCP tool spans**: When an MCP tool is invoked
2. **Agentic tool spans**: When kubectl subprocess is executed

This creates a hierarchy: MCP invocation → tool execution → kubectl call

---

## Research Approach

**Primary sources first, semantic conventions from the ground up.**

### Official Documentation (Primary)
- **OpenTelemetry JS SDK**: https://opentelemetry.io/docs/languages/js/
- **OpenTelemetry Semantic Conventions**: https://opentelemetry.io/docs/specs/semconv/
  - General conventions for spans, attributes, resources
  - GenAI semantic conventions (if available for LLM observability)
- **OpenTelemetry Weaver**: Tool for working with semantic conventions - evaluate if applicable

### Semantic Conventions Focus
Start with official semantic conventions rather than inventing attribute names:
- What conventions exist for HTTP/RPC calls?
- What conventions exist for subprocess/command execution?
- What conventions exist for GenAI/LLM operations?
- How should we name spans according to conventions?

### Questions to Answer During Research
1. What are the current OTel JS SDK packages and versions?
2. What semantic conventions apply to our span types (tool calls, subprocess execution)?
3. Are there GenAI semantic conventions for LLM tool use?
4. Does OpenTelemetry Weaver help with convention compliance?
5. What's the recommended tracer/provider setup pattern?
6. How do official examples structure span hierarchies?

### Viktor's Implementation (Compare, Don't Copy)
Study Viktor's dot-ai OTel implementation to understand his approach:
- What naming conventions does he use for spans and attributes?
- How does he structure the span hierarchy?
- **Compare against semantic conventions** - if Viktor's conventions differ from semconv, prefer semconv
- What can we learn from his integration architecture?

### Decisions to Make
- OTel SDK version and packages
- Which semantic conventions to follow (semconv takes precedence)
- Whether OpenTelemetry Weaver applies to our use case
- Span naming conventions (following semconv, noting where Viktor differs)
- What attributes to capture on each span type
- Default exporter (console for dev, OTLP for production)

---

## Success Criteria

- [ ] MCP tool invocations create spans
- [ ] kubectl executions create child spans
- [ ] Traces visible in console output (for development)
- [ ] Traces exportable via OTLP (for backends like Datadog)
- [ ] Documentation explains OTel concepts and our implementation

## Milestones

- [ ] **M1**: Research Phase
  - Study OpenTelemetry JS SDK documentation and official examples
  - Research OpenTelemetry semantic conventions (general + GenAI if available)
  - Evaluate OpenTelemetry Weaver for convention compliance
  - Study Viktor's naming conventions and compare against semconv
  - Research current SDK versions and patterns (landscape changing rapidly)
  - Document findings in `docs/opentelemetry-research.md`
  - Update this PRD with specific implementation decisions

- [ ] **M2**: Basic OTel Setup
  - Install OTel SDK packages
  - Configure tracer provider
  - Add console exporter for development visibility
  - Create `docs/opentelemetry.md` explaining OTel concepts and our setup
  - Manual test: traces appear in console

- [ ] **M3**: Instrument MCP Tools
  - Create spans for MCP tool invocations
  - Add relevant attributes (tool name, inputs, outputs)
  - Handle errors and set span status
  - Manual test: MCP tool calls create proper spans

- [ ] **M4**: Instrument kubectl Execution
  - Create child spans for kubectl subprocess calls
  - Add attributes (command, namespace, duration)
  - Capture errors and exit codes
  - Manual test: kubectl calls show as child spans

- [ ] **M5**: OTLP Export
  - Configure OTLP exporter for external backends
  - Environment variable configuration for collector endpoint
  - Verify traces reach external collector
  - Update documentation with export configuration

## Technical Approach

*To be determined during M1 research phase. Key decisions:*

- OTel SDK packages and versions
- Tracer initialization pattern
- Span attribute schema
- Context propagation approach
- Exporter configuration strategy

## Reference Sources

- **OpenTelemetry JS SDK**: https://opentelemetry.io/docs/languages/js/ (primary)
- **OpenTelemetry Semantic Conventions**: https://opentelemetry.io/docs/specs/semconv/ (primary)
- **OpenTelemetry Weaver**: https://github.com/open-telemetry/weaver (evaluate applicability)
- **Viktor's observability guide**: https://devopstoolkit.ai/docs/mcp/guides/observability-guide
- **Viktor's dot-ai**: Reference for integration architecture, compare naming conventions

## Out of Scope

- Metrics (traces only for POC)
- Logs correlation (future work)
- Automatic instrumentation of HTTP calls
- Sampling strategies (trace everything for POC)

## Dependencies

- MCP server (from PRD #5) - for MCP tool spans
- Existing kubectl tools (from PRD #1) - for kubectl spans

## Testing

Manual verification:
1. Console output shows span hierarchy
2. Spans include expected attributes
3. Errors are properly captured
4. OTLP export reaches test collector

---

## Design Decisions

*Decisions will be logged here as they're made during implementation.*

---

## Progress Log

*Progress will be logged here as milestones are completed.*
