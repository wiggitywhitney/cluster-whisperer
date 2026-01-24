# PRD #7: Vector Database Integration (Chroma)

**Status**: Not Started
**Created**: 2026-01-24
**GitHub Issue**: [#7](https://github.com/wiggitywhitney/cluster-whisperer/issues/7)

---

## Problem Statement

Kubernetes clusters often have dozens or hundreds of CRDs and APIs. Developers face:
- Overwhelming number of custom resources to navigate
- No easy way to discover what APIs are available
- Difficulty understanding which CRD to use for their task

The agent needs a way to help developers find relevant resources based on what they're trying to accomplish, not just what they already know to ask for.

## Solution

Integrate Chroma as a vector database to store and query Kubernetes API/CRD knowledge. Add a tool the agent can use to search this knowledge base semantically.

### Viktor's Controller Pattern

Viktor's approach (to be validated in research):
1. A controller runs in the target cluster
2. Controller watches Kubernetes events (CRD changes, API additions)
3. When changes occur, controller notifies an endpoint
4. An agent receives the change and updates the vector database

This keeps the vector DB in sync with the actual cluster state.

---

## Viktor's Implementation Reference

**Before implementation, research Viktor's vector DB patterns in dot-ai:**

### Files to Study
- Chroma/Qdrant setup and configuration
- Vector embedding approach (what gets embedded)
- Controller implementation for K8s event watching
- Sync mechanism between cluster and vector DB
- Query tool implementation

### Questions to Answer During Research
1. What does Viktor embed - CRD specs, descriptions, examples?
2. How does the controller watch for changes?
3. What's the sync architecture (push vs pull, real-time vs batch)?
4. How does the query tool format results for the LLM?
5. What embedding model does he use?

### Decisions to Make
- What to embed (CRD specs, API docs, examples, all of the above)
- Embedding model choice
- Sync strategy (real-time controller vs batch sync vs manual)
- Chroma deployment (in-memory, local persistent, remote)
- Query result format

### Scope Consideration
This PRD may need to split into multiple PRDs if research reveals the controller pattern is substantial. Potential split:
- PRD #7a: Chroma setup + query tool (manual data loading)
- PRD #7b: K8s controller for automatic sync

---

## Success Criteria

- [ ] Chroma database stores Kubernetes API/CRD information
- [ ] Agent can query the vector DB to find relevant resources
- [ ] Query results help agent understand which APIs to use
- [ ] Documentation explains vector DB concepts and our implementation

## Milestones

- [ ] **M1**: Research Phase
  - Study Viktor's dot-ai vector DB implementation
  - Research current Chroma versions and patterns
  - Research embedding models for technical documentation
  - Understand Viktor's controller pattern for K8s sync
  - Document findings in `docs/vector-db-research.md`
  - Decide if PRD needs to split (controller as separate PRD)
  - Update this PRD with specific implementation decisions

- [ ] **M2**: Chroma Setup
  - Install Chroma packages
  - Configure Chroma instance (in-memory or persistent based on research)
  - Choose and configure embedding model
  - Create `docs/vector-database.md` explaining vector DB concepts
  - Manual test: can store and retrieve test documents

- [ ] **M3**: Data Loading Strategy
  - Determine what Kubernetes data to embed
  - Create loading mechanism (manual for POC, or controller if not split out)
  - Load initial dataset (cluster CRDs/APIs)
  - Manual test: relevant data is in the database

- [ ] **M4**: Query Tool Implementation
  - Create MCP tool for semantic search
  - Format results for LLM consumption
  - Integrate with existing agent tools
  - Manual test: agent can find relevant CRDs for user questions

- [ ] **M5**: Integration and Polish
  - Test with realistic scenarios (finding right CRD for a task)
  - Tune retrieval parameters (top-k, similarity threshold)
  - Update documentation with usage patterns
  - End-to-end test: user asks about deploying something, agent finds relevant CRDs

## Technical Approach

*To be determined during M1 research phase. Key decisions:*

- Chroma version and deployment mode
- Embedding model (OpenAI, local, etc.)
- Data schema (what fields, what metadata)
- Sync strategy (manual, scripted, controller)
- Query result format

## Reference Examples

- **Viktor's dot-ai**: Primary reference for vector DB patterns
- **Chroma**: https://docs.trychroma.com/
- **Viktor's controller**: To be identified in research

## Out of Scope (potentially separate PRD)

- Real-time K8s event watching controller (may split to separate PRD)
- Multi-cluster support
- User-specific embeddings
- Fine-tuned embedding models

## Dependencies

- MCP server (from PRD #5) - query tool exposed via MCP
- Embedding model access (API key or local model)

## Testing

Test against real cluster using spider-rainbows Kind setup.

Scenarios:
- "How do I deploy a database?" → finds relevant CRDs
- "What Crossplane providers are available?" → finds provider CRDs
- "How do I configure ingress?" → finds ingress-related resources

---

## Design Decisions

*Decisions will be logged here as they're made during implementation.*

---

## Progress Log

*Progress will be logged here as milestones are completed.*
