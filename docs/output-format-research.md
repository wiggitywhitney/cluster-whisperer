# Output Format Research: JSON vs YAML vs Plain Text

**Date**: 2026-01-25
**Context**: PRD #5 MCP Server Interface - deciding on kubectl output format

---

## The Question

What format should kubectl tool output use when returning data to an LLM?

**Two competing concerns**:
1. **Token efficiency** - More tokens for data = less room for reasoning
2. **Downstream processing** - Structured data may be needed for vector DB, APIs, etc.

---

## Token Efficiency: Verified by Research

### Source
[Piotr Sikora's format comparison study (Dec 2025)](https://www.piotr-sikora.com/blog/2025-12-05-toon-tron-csv-yaml-json-format-comparison)

### Efficiency Rankings

| Format | Efficiency | Savings vs JSON |
|--------|------------|-----------------|
| CSV/Plain text | ~100% | **80% savings** |
| TOON (Token Oriented Object Notation) | 85-92% | 75% savings |
| YAML | 65% | 41% savings |
| **JSON** | **45%** | baseline (most verbose) |

### What This Means in Practice

**Context window capacity** (128K token limit):
- JSON: ~17K records fit
- YAML: ~29K records fit
- CSV/Plain text: ~85K records fit

JSON can hold **5x fewer records** than plain text in the same context window.

### Cost Impact (10K Records, GPT-4 Pricing)

| Format | Cost/Call | Annual Cost (1M calls) |
|--------|-----------|------------------------|
| JSON | $5.60 | $5.6M |
| YAML | $3.33 | $3.3M |
| CSV | $1.14 | $1.14M |

### Specific Example: Flat Data (10 users)

| Format | Characters | Relative Size |
|--------|------------|---------------|
| JSON | 746 | baseline |
| YAML | ~450 | 40% smaller |
| Plain text/CSV | 184 | **75% smaller** |

### Why JSON Uses More Tokens

JSON's syntax overhead:
- Every string needs quotes: `"name"`, `"value"`
- Structural punctuation: `{`, `}`, `[`, `]`, `:`, `,`
- Each punctuation mark is often a separate token

Plain text/tables avoid this overhead entirely.

---

## JSON Advantages: Verified by Research

### Sources
- [JFrog: Integrating Vector Databases with LLMs](https://jfrog.com/blog/utilizing-llms-with-embedding-stores/)
- [BentoML: Structured Outputs](https://bentoml.com/llm/getting-started/tool-integration/structured-outputs)

### When JSON Wins

**Downstream processing**: When output flows to other systems
> "If you're building a larger application with an LLM (e.g., one that connects the model's response to another service, API, or database), you need predictable structure."

**Programmatic consumption**: When code needs to parse the output
> "Structured outputs are responses from an LLM that follow a specific, machine-readable format... the model produces data that can be parsed and used directly by downstream systems."

**Vector database integration**: When storing alongside embeddings
> "Generating and storing document embeddings, along with JSON versions of the documents themselves, creates an easy mechanism for the LLM to interface with the vector store."

### JSON Use Cases (from research)

- Information extraction (entities, relationships → JSON/tables)
- Function calling and API chaining
- Agent orchestration (multi-step workflows)
- Evaluation and testing (consistent responses for benchmarking)
- Storing with vector embeddings for retrieval

---

## The Tradeoff Summary

| Concern | Best Format | Why |
|---------|-------------|-----|
| Token efficiency | Plain text/CSV | 80% fewer tokens than JSON |
| Human readability | YAML | Clean, indentation-based |
| Downstream processing | JSON | Parseable, consistent schema |
| Vector DB storage | JSON | Structured for embedding metadata |
| LLM reasoning ability | All work | LLMs can parse tables, JSON, YAML |

---

## What's NOT Verified

**Viktor Farcic's specific rationale for recommending JSON**

From meeting notes (2026-01-20): "DATA IS RETURNED (viktor recommends JSON)"
From meeting notes (2026-01-13): "get used to giving instructions on only and exclusively answer in JSON"

I searched:
- Viktor's dot-ai GitHub repository
- DevOps AI Toolkit documentation
- Web searches for his explicit statements

**Could not find Viktor explicitly documenting WHY he recommends JSON.** His rationale is not publicly documented (that I could find).

**Hypothesis**: Viktor's recommendation may be related to:
1. His use of vector databases (Qdrant) for storing Kubernetes data
2. The need for structured data in his controller sync architecture
3. Consistent parsing in multi-agent workflows

This hypothesis is supported by general research but not confirmed by Viktor's own documentation.

---

## Open Question for This Project

**Does PRD #7 (vector database) need to consume kubectl tool output directly?**

Two possible architectures:

**Architecture A: Tool output → Vector DB**
```
kubectl tool → JSON output → stored in Chroma → queried later
```
In this case, JSON is valuable because the same output serves both LLM reasoning AND storage.

**Architecture B: Separate sync**
```
kubectl tool → plain text → LLM reasoning only
K8s controller → watches events → syncs to Chroma separately
```
In this case, plain text is fine for tools because vector DB gets data from a different source.

Viktor's meeting notes mention a controller pattern:
> "Viktor's controller runs in the target cluster, watches for changes by subscribing to kubernetes events, and when one happens it tells an endpoint somewhere that does the syncing"

This suggests **Architecture B** - but needs confirmation.

---

## Research Sources

### Token Efficiency
- [TOON vs JSON vs YAML Token Efficiency (Medium)](https://medium.com/@ffkalapurackal/toon-vs-json-vs-yaml-token-efficiency-breakdown-for-llm-5d3e5dc9fb9c)
- [Token Optimization vs Context Loss (Medium)](https://saurav-samantray.medium.com/token-optimization-vs-context-loss-across-data-formats-json-vs-yaml-vs-csv-vs-toon-b2b145e06510)
- [Piotr Sikora Format Comparison](https://www.piotr-sikora.com/blog/2025-12-05-toon-tron-csv-yaml-json-format-comparison)
- [YAML vs JSON for LLMs (LinkedIn)](https://www.linkedin.com/pulse/yaml-vs-json-why-wins-large-language-model-outputs-luciano-ayres-5kqif)
- [LLM Output Formats: JSON vs TSV (Medium)](https://david-gilbertson.medium.com/llm-output-formats-why-json-costs-more-than-tsv-ebaf590bd841)

### Structured Output & Vector DBs
- [JFrog: LLMs with Embedding Stores](https://jfrog.com/blog/utilizing-llms-with-embedding-stores/)
- [BentoML: Structured Outputs](https://bentoml.com/llm/getting-started/tool-integration/structured-outputs)
- [Instaclustr: Vector Databases and LLMs](https://www.instaclustr.com/education/open-source-ai/vector-databases-and-llms-better-together/)
