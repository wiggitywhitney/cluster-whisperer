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

## Research Approach

**Primary sources first, then reference implementations.**

### Official Documentation (Primary)
- **Datadog OTLP Ingestion**: https://docs.datadoghq.com/tracing/trace_collection/otlp_ingest_in_datadog/
- **Datadog APM**: Trace visualization, service maps, flame graphs
- **Datadog LLM Observability**: https://docs.datadoghq.com/llm_observability/ (if applicable)
  - What LLM-specific features does Datadog offer?
  - What trace attributes enable these features?

### Questions to Answer During Research
1. What's the current Datadog OTLP ingestion setup and configuration?
2. Does Datadog have LLM Observability features? What attributes enable them?
3. What are Datadog's recommended service naming conventions?
4. What environment tagging strategy does Datadog recommend?
5. How do OTel semantic conventions map to Datadog's expected attributes?
6. What Datadog-specific configuration optimizes trace visualization?

### Viktor's Implementation (Architecture Reference)
Study Viktor's observability setup for integration patterns:
- How does he configure OTLP export?
- What service naming conventions does he use?
- Note: Viktor uses Jaeger, not Datadog - the OTLP patterns transfer, but Datadog-specific features won't

### Decisions to Make
- Datadog API key management (via Teller)
- Service naming convention (follow Datadog recommendations)
- Environment tagging strategy
- Which Datadog features to highlight in demo
- Whether to use Datadog LLM Observability features

---

## Success Criteria

- [ ] Traces from PRD #6 appear in Datadog APM
- [ ] Trace hierarchy visible (MCP tool → kubectl execution)
- [ ] Relevant attributes visible (tool names, durations, errors)
- [ ] Documentation explains Datadog setup and LLM observability concepts

## Milestones

- [ ] **M1**: Research Phase
  - Study Datadog OTLP ingestion documentation
  - Research Datadog LLM Observability features and requirements
  - Research Datadog service naming and tagging conventions
  - Reference Viktor's OTLP patterns (he uses Jaeger, principles may transfer)
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

## Reference Sources

- **Datadog OTLP Ingestion**: https://docs.datadoghq.com/tracing/trace_collection/otlp_ingest_in_datadog/ (primary)
- **Datadog LLM Observability**: https://docs.datadoghq.com/llm_observability/ (evaluate applicability)
- **Datadog APM Best Practices**: Service naming, tagging, etc.
- **Viktor's observability guide**: https://devopstoolkit.ai/docs/mcp/guides/observability-guide
- **Viktor's dot-ai**: Reference for OTLP patterns (uses Jaeger, not Datadog)

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

### 2026-01-27: OTLP Ingestion Approach (from PRD #6 research)

**Finding:** Datadog's direct OTLP intake has different maturity levels:
- Logs: GA
- Metrics: GA
- Traces: **LLM Observability only** (Preview for general APM)

**Decision:** Use **Datadog Agent with OTLP ingestion** instead of direct OTLP to Datadog endpoint.

**Rationale:**
- Datadog Agent v6.32.0+/v7.32.0+ supports OTLP ingestion on ports 4317 (gRPC) and 4318 (HTTP)
- This is Datadog's recommended approach for APM traces
- Simpler than running a separate OpenTelemetry Collector
- Agent handles buffering, retry, and Datadog-specific transformations

**Configuration approach:**
```bash
# Datadog Agent config
DD_OTLP_CONFIG_RECEIVER_PROTOCOLS_HTTP_ENDPOINT=0.0.0.0:4318

# Application config
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
```

**Alternative:** If we specifically want Datadog's LLM Observability features, direct OTLP may work. Research in M1 should evaluate whether LLM Observability provides value for our demo.

---

## Progress Log

*Progress will be logged here as milestones are completed.*
