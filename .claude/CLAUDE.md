# Cluster Whisperer

## Terminology Corrections

**Correct the user if they confuse LangChain and LangGraph** - even if you understand from context. This is for a KubeCon presentation; precise terminology matters.

## Code Style

This is a learning-focused repository. All code and documentation should:
- Include doc strings explaining what the code does and why
- Use plain language that someone with no prior knowledge can understand
- Be succinct - explain concepts clearly without unnecessary verbosity
- Prioritize teaching over production optimization

## Architecture Principles

- **Separate tools for permissions**: Each kubectl operation (get, describe, logs) is a separate tool
- **Visible reasoning**: The agent outputs its thinking so users can see the decision process
- **Read-only first**: POC focuses on investigation tools, not mutations

## Package Distribution

Keep production dependencies minimal:
- Only include what's strictly necessary for core functionality
- Use targeted OTel packages, NOT auto-instrumentations
- Regularly audit package size: `du -sh node_modules/` and `npm ls --prod`

## Secrets Management

This project uses vals for secrets. See `.vals.yaml` for available secrets and `~/Documents/Repositories/claude-config/guides/vals-usage.md` for vals commands.

<!-- Git workflow, CodeRabbit reviews enforced globally via ~/.claude/CLAUDE.md -->
