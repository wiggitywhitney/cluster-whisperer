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

## Infrastructure Safety

- **NEVER run `teardown.sh` or delete Kind/GKE clusters without explicit human approval.** Always confirm with the user before executing any destructive infrastructure commands.
- Do not run `setup.sh` without confirming the target mode (kind/gcp) with the user — GKE creates billable resources.
- **A running GCP cluster is required for PRD work in this repo.** The demo is designed so the presenter's default shell has **no** `KUBECONFIG` set — `kubectl cluster-info` will always fail with "connection refused" and that is intentional. The correct check is:
  ```bash
  kubectl --kubeconfig ~/.kube/config-cluster-whisperer cluster-info
  ```
  If that fails, the cluster is not running. Halt and ask the user to provision one before continuing. Do NOT skip, defer, or design around the missing cluster. To provision: `./demo/cluster/setup.sh gcp` (no vals wrapper needed).

## Secrets Management

This project uses vals for secrets. See `.vals.yaml` for available secrets.
Vals commands: @~/Documents/Repositories/claude-config/guides/vals-usage.md

<!-- Git workflow, CodeRabbit reviews enforced globally via ~/.claude/CLAUDE.md -->
