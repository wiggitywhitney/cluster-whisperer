# Documentation

## Agent

How the investigation agent works — the reasoning loop, tool design, and interfaces.

- [agentic-loop-langgraph.md](agent/agentic-loop-langgraph.md) — ReAct pattern, streaming events, and system prompt (LangGraph implementation)
- [agentic-loop-vercel.md](agent/agentic-loop-vercel.md) — The same agentic loop through the Vercel AI SDK
- [kubectl-tools-langgraph.md](agent/kubectl-tools-langgraph.md) — Tool contract, shell injection prevention, directive descriptions (LangGraph wrappers)
- [kubectl-tools-vercel.md](agent/kubectl-tools-vercel.md) — Tool wrapping, factories, and graceful degradation (Vercel AI SDK wrappers)
- [mcp-server.md](agent/mcp-server.md) — MCP interface for using cluster-whisperer tools from Claude Code or other MCP clients

## Pipeline

How Kubernetes knowledge gets into the vector database for semantic search.

- [capability-inference-pipeline.md](pipeline/capability-inference-pipeline.md) — CRD discovery, LLM-powered schema analysis, and vector storage
- [vector-database.md](pipeline/vector-database.md) — Vector DB concepts, embeddings, cosine distance, and search dimensions
- [resource-instance-sync.md](pipeline/resource-instance-sync.md) — Discovering running resources and indexing their metadata

## Observability

How you see what the agent is doing — tracing, span conventions, and telemetry.

- [opentelemetry.md](observability/opentelemetry.md) — OTel setup, peer dependencies, exporters, and Datadog integration
- [tracing-conventions.md](observability/tracing-conventions.md) — Span hierarchy, context propagation, and design rationale
- [telemetry-generated/](observability/telemetry-generated/) — Auto-generated attribute reference from the Weaver schema

## Talk

Materials from the KubeCon "Choose Your Own Adventure" presentation.

- [abstract.md](talk/abstract.md) — Conference abstract
- [choose-your-adventure-demo.md](talk/choose-your-adventure-demo.md) — Full demo flow, act by act
- [demo-design.md](talk/demo-design.md) — Expected agent investigation behavior and why the demo app is structured the way it is
- [demo-rehearsal-runbook.md](talk/demo-rehearsal-runbook.md) — Step-by-step commands for running the demo

## Research

Technology research and decision-making artifacts from development.

- [extended-thinking-research.md](research/extended-thinking-research.md) — Claude extended thinking evaluation
- [langgraph-vs-langchain.md](research/langgraph-vs-langchain.md) — Framework comparison
- [mcp-research.md](research/mcp-research.md) — Model Context Protocol research
- [opentelemetry-research.md](research/opentelemetry-research.md) — OTel implementation research
- [output-format-research.md](research/output-format-research.md) — CLI output formatting options
- [vector-db-research.md](research/vector-db-research.md) — Vector database selection
- [weaver-research.md](research/weaver-research.md) — OTel Weaver schema validation
- [viktors-pipeline-assessment.md](research/viktors-pipeline-assessment.md) — Assessment of dot-ai reference implementation
- [m1-vercel-ai-sdk-research.md](research/m1-vercel-ai-sdk-research.md) — Vercel AI SDK 6 research for agent implementation
- [21-content-column-research.md](research/21-content-column-research.md) — Datadog LLM Observability content column investigation
- [21-content-column-fix-narrative.md](research/21-content-column-fix-narrative.md) — Content column fix story
- [33-otel-baseline-traces.md](research/33-otel-baseline-traces.md) — OTel baseline trace analysis
- [49-m7-datadog-llmobs-otel-mapping.md](research/49-m7-datadog-llmobs-otel-mapping.md) — Datadog LLMObs to OTel attribute mapping
