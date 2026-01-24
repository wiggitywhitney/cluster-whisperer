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

## Viktor's Implementation Reference

**Before implementation, research Viktor's OTel patterns in dot-ai:**

### Files to Study
- OpenTelemetry setup and configuration
- Span creation patterns for MCP tools
- Span creation patterns for agentic tools
- Trace context propagation
- Exporter configuration

### Questions to Answer During Research
1. What OTel SDK does Viktor use for Node.js/TypeScript?
2. How does he structure the span hierarchy?
3. What attributes does he add to spans (model name, token counts, etc.)?
4. How does he handle async operations and tool calls?
5. What exporters does he configure?

### Decisions to Make
- OTel SDK version and packages
- Span naming conventions
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
  - Study Viktor's dot-ai OTel implementation
  - Research current OpenTelemetry JS SDK versions and patterns
  - Research LLM observability best practices (what attributes matter)
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

## Reference Examples

- **Viktor's dot-ai**: Primary reference for OTel patterns
- **Viktor's observability guide**: https://devopstoolkit.ai/docs/mcp/guides/observability-guide
- **OpenTelemetry JS**: https://opentelemetry.io/docs/languages/js/

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
