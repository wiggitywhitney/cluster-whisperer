# PRD #8: Datadog Observability

**Status**: Complete
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

- [x] Traces from PRD #6 appear in Datadog APM
- [x] Trace hierarchy visible (MCP tool → kubectl execution)
- [x] Relevant attributes visible (tool names, durations, errors)
- [x] Documentation explains Datadog setup and LLM observability concepts

## Milestones

- [x] **M1**: Research Phase
  - Study Datadog OTLP ingestion documentation
  - Research Datadog LLM Observability features and requirements
  - Research Datadog service naming and tagging conventions
  - Reference Viktor's OTLP patterns (he uses Jaeger, principles may transfer)
  - ~~Document findings in `docs/datadog-research.md`~~ → consolidated in `docs/opentelemetry.md`
  - Update this PRD with specific configuration decisions

- [x] **M2**: Datadog Setup
  - Configure Datadog API key (via vals)
  - Set up OTLP exporter to Datadog endpoint
  - Configure service name and environment tags
  - ~~Create `docs/datadog-observability.md`~~ → consolidated in `docs/opentelemetry.md`
  - Manual test: traces appear in Datadog APM ✓

- [x] **M3**: Trace Enrichment
  - Add Datadog-specific attributes if beneficial → using OTel GenAI semconv, works well
  - Configure trace sampling if needed → not needed for POC
  - Optimize trace data for Datadog visualization → hierarchy and attributes display correctly
  - Manual test: traces show useful information in Datadog UI ✓

- [~] **M4**: Demo Polish (deferred - KubeCon is 6 weeks away)
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

### 2026-02-02: Documentation Consolidation

**Decision:** Consolidate Datadog documentation into `docs/opentelemetry.md` instead of creating separate `docs/datadog-research.md` and `docs/datadog-observability.md`.

**Rationale:**
- PRD #6 (OpenTelemetry) was completed first and naturally included Datadog setup as the backend
- Datadog is just one OTLP backend option (alongside Jaeger) - the setup is backend-agnostic
- Creating separate docs would duplicate content and require readers to cross-reference
- The existing `docs/opentelemetry.md` already covers: local Datadog Agent setup, in-cluster setup, LLM Observability features, known limitations, and troubleshooting

**Documentation location:** All Datadog-related documentation is in `docs/opentelemetry.md` under the "OTLP Export" and "Datadog Setup" sections.

### 2026-02-02: Local Datadog Agent Architecture

**Decision:** Use local Datadog Agent running on developer machine instead of in-cluster agent.

**Rationale:**
- Simpler setup - no port-forwarding required
- Agent already running locally for other Datadog integrations
- Works across different Kubernetes clusters without reconfiguration
- OTLP endpoint at `localhost:4318` is always available

**Previous approach:** In-cluster Datadog Agent required `kubectl port-forward` which added complexity and was cluster-specific.

---

## Progress Log

### 2026-02-02: M1-M3 Complete, M4 Deferred

- Verified traces flow correctly through local Datadog Agent to Datadog APM
- Confirmed span hierarchy: MCP tool spans → kubectl subprocess spans (parent-child)
- Confirmed attributes visible: `process.command_args`, `process.exit.code`, `k8s.namespace`, `k8s.output_size_bytes`, `traceloop.entity.name`
- Tested with complex investigation query ("Find the broken pod and tell me why it's failing") - multiple tool calls traced correctly
- Documentation consolidated in `docs/opentelemetry.md` per design decision
- M4 (Demo Polish) deferred - KubeCon is 6 weeks away, basic functionality complete
