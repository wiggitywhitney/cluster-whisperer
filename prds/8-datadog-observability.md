# PRD #8: Datadog Observability

**Status**: Not Started
**Created**: 2026-01-24
**GitHub Issue**: [#8](https://github.com/wiggitywhitney/cluster-whisperer/issues/8)

---

## Problem Statement

OpenTelemetry traces need a production-ready backend for visualization, alerting, and analysis. For the KubeCon demo, we want to show traces in a real observability platform that attendees will recognize and can use themselves.

Datadog provides:
- Rich trace visualization
- LLM-specific observability features
- Familiar UI for platform engineers

## Solution

Connect OpenTelemetry traces to Datadog APM. This builds on PRD #6 (OTel instrumentation) by configuring the OTLP exporter to send traces to Datadog.

### Demo Value

This is Problem #3 in the KubeCon demo: "What is my agent doing? Which tools is it using?"

The audience can see the full investigation trace - from user question through tool calls to final answer - visualized in Datadog's APM UI.

---

## Viktor's Implementation Reference

**Before implementation, research Viktor's Datadog patterns (he uses Jaeger, but principles apply):**

### Files to Study
- OTLP exporter configuration
- Trace attributes for LLM observability
- Service naming and tagging
- Environment configuration

### Questions to Answer During Research
1. What's the current Datadog OTLP ingestion setup?
2. What trace attributes does Datadog use for LLM observability?
3. How does Viktor structure service names and tags?
4. What Datadog-specific configuration is needed?
5. Are there Datadog LLM observability features we should leverage?

### Decisions to Make
- Datadog API key management
- Service naming convention
- Environment tagging strategy
- Which Datadog features to highlight in demo

---

## Success Criteria

- [ ] Traces from PRD #6 appear in Datadog APM
- [ ] Trace hierarchy visible (MCP tool → kubectl execution)
- [ ] Relevant attributes visible (tool names, durations, errors)
- [ ] Documentation explains Datadog setup and LLM observability concepts

## Milestones

- [ ] **M1**: Research Phase
  - Research current Datadog OTLP ingestion patterns
  - Research Datadog LLM observability features
  - Study Viktor's observability patterns (Jaeger-based but principles transfer)
  - Document findings in `docs/datadog-research.md`
  - Update this PRD with specific configuration decisions

- [ ] **M2**: Datadog Setup
  - Configure Datadog API key (via Teller)
  - Set up OTLP exporter to Datadog endpoint
  - Configure service name and environment tags
  - Create `docs/datadog-observability.md` explaining Datadog integration
  - Manual test: traces appear in Datadog APM

- [ ] **M3**: Trace Enrichment
  - Add Datadog-specific attributes if beneficial
  - Configure trace sampling if needed
  - Optimize trace data for Datadog visualization
  - Manual test: traces show useful information in Datadog UI

- [ ] **M4**: Demo Polish
  - Create demo-friendly trace scenarios
  - Verify trace visualization is clear and educational
  - Document demo walkthrough
  - Update README with Datadog observability instructions

## Technical Approach

*To be determined during M1 research phase. Key decisions:*

- OTLP exporter configuration for Datadog
- API key management approach
- Service naming and tagging
- Datadog-specific optimizations

## Reference Examples

- **Viktor's dot-ai**: Jaeger patterns (principles transfer)
- **Viktor's observability guide**: https://devopstoolkit.ai/docs/mcp/guides/observability-guide
- **Datadog OTLP**: https://docs.datadoghq.com/tracing/trace_collection/otlp_ingest_in_datadog/

## Out of Scope

- Datadog metrics (traces only)
- Datadog logs integration
- Alerting and monitors
- Cost optimization (POC scope)

## Dependencies

- OpenTelemetry instrumentation (PRD #6) - provides the traces
- Datadog account with APM enabled
- Datadog API key

## Testing

Verification:
1. Run agent investigation
2. Traces appear in Datadog within seconds
3. Span hierarchy is correct
4. Attributes are visible and useful
5. Demo scenario looks good in UI

---

## Design Decisions

*Decisions will be logged here as they're made during implementation.*

---

## Progress Log

*Progress will be logged here as milestones are completed.*
