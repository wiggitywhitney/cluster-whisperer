
# Livin' In the Future: Your Platform's Next Interface Is an AI Agent

Platform engineers provide capabilities to internal developers, and they build interfaces to those capabilities that meet developers where they are already working, be it web portal, CLI, or API. But lately, "where developers are already working" is alongside their AI coding assistant.

Developers want to be able to ask the platform natural language questions like "Why won't my application deploy?" and "What types of databases are available to me?," and receive helpful answers. Developers want their coding assistant to investigate the platform's underlying Kubernetes cluster, surface the problem, and then apply fixes or recommend capabilities.

This session is a live demo of exactly that: an AI agent that a coding assistant can use to interface with an internal platform on the developer's behalf. It is built from scratch with LangGraph, a vector database, and OpenTelemetry instrumentation. It is available to the coding assistant via MCP and CLI.

LangGraph handles the Kubernetes cluster investigation tools. Then the vector database makes the cluster's capabilities searchable by natural language query. Finally, the traces help platform engineers understand how developers are using the agent: every LLM call, every tool execution, every reasoning step visible in an observability backend.

This talk will show you why custom AI agents are wildly useful as a platform interface, and how to start building one at your organization.



Benefit to the Ecosystem:

Platform engineering and AI are converging quickly, but the community's guidance has not caught up. The CNCF Platforms White Paper and Platform Engineering Maturity Model do not yet address AI agents as platform interfaces. This talk fills that gap by showing one concrete, buildable path for integrating AI into an existing Internal Developer Platform. It will give the audience a broader sense of how emerging AI tooling (models, agents, vector databases, observability, and MCP servers) can complement platform-building technologies and influence system design.

This demo touches on many projects in the CNCF landscape, including Kubernetes, Crossplane, OpenTelemetry, and Jaeger.
