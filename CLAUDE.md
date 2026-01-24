# Project Guidelines

This is a learning-focused repository for a KubeCon presentation. All code and documentation should:

- Include doc strings explaining what the code does and why
- Use plain language that someone with no prior knowledge can understand
- Be succinct - explain concepts clearly without unnecessary verbosity
- Prioritize teaching over production optimization

## Project Context

**Purpose**: AI agent that answers natural language questions about Kubernetes clusters
**Audience**: Platform engineers learning to build developer tools
**Presentation**: KubeCon Spring 2026

## Architecture

This project uses LangChain to create an agentic loop with multiple kubectl tools:

```
User Question → Agentic Loop → [kubectl tools] → Cluster → Answer
```

Key principles:
- **Separate tools for permissions**: Each kubectl operation (get, describe, logs) is a separate tool
- **Visible reasoning**: The agent outputs its thinking so users can see the decision process
- **Read-only first**: POC focuses on investigation tools, not mutations

## Reference Examples

Viktor's examples for patterns to follow:
- kubectl tools: https://github.com/vfarcic/dot-ai/blob/main/src/core/kubectl-tools.ts
- Agent with tools: https://github.com/vfarcic/dot-ai/blob/main/src/tools/query.ts

## Secrets Management with vals

This project requires `ANTHROPIC_API_KEY` for the LangChain agent. Secrets are injected using [vals](https://github.com/helmfile/vals).

```bash
# Run with secrets injected (-i inherits PATH so kubectl is found)
vals exec -i -f .vals.yaml -- node dist/index.js "your question"

# Verify secrets are configured
vals eval -f .vals.yaml
```

## Git Workflow

- Create PRs to merge to main
- Don't squash git commits
- Make a new branch for each feature/PRD
- Ensure CodeRabbit review is examined before merging
