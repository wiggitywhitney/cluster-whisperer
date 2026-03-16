// ABOUTME: Routes agent creation to the correct framework based on --agent flag.
// ABOUTME: Returns an InvestigationAgent — the framework-agnostic interface both agents implement.

/**
 * Agent factory — constructs the right agent based on the --agent CLI flag.
 *
 * This factory decouples the CLI from specific agent implementations.
 * Both the LangGraph adapter and the Vercel agent implement the
 * InvestigationAgent interface, so the CLI just calls agent.investigate()
 * regardless of which framework is in use.
 *
 * Currently supported:
 * - langgraph: Wraps the existing agent via LangGraphAdapter
 * - vercel: Uses the Vercel AI SDK's streamText() with Claude
 */

import { LangGraphAdapter } from "./langgraph-adapter";
import { VercelAgent } from "./vercel-agent";
import { DEFAULT_AGENT_TYPE, type AgentType } from "./agent-types";
import type { InvestigationAgent } from "./agent-interface";
import { type ToolGroup } from "../tools/tool-groups";
import { type VectorBackendType } from "../vectorstore";

/**
 * Options for creating an agent via the factory.
 *
 * Note: checkpointer (MemorySaver) was removed — conversation memory is now
 * handled internally by each agent's investigate() method. Thread ID is
 * passed to investigate() instead of to the factory.
 */
export interface CreateAgentOptions {
  /** Which agent framework to use. Defaults to "langgraph". */
  agentType?: AgentType;
  /** Which tool groups to include. Passed through to the agent constructor. */
  toolGroups?: ToolGroup[];
  /** Which vector database backend to use. Defaults to "chroma". */
  vectorBackend?: VectorBackendType;
  /**
   * Path to a kubeconfig file for kubectl operations.
   * Passed through to tool creation so all kubectl calls use this cluster.
   */
  kubeconfig?: string;
}

/**
 * Creates an agent using the specified framework.
 *
 * @param options - Agent type and tool group configuration
 * @returns An InvestigationAgent that streams AgentEvent objects
 * @throws Error if the requested agent type is not yet implemented
 */
export function createAgent(options: CreateAgentOptions = {}): InvestigationAgent {
  const agentType = options.agentType ?? DEFAULT_AGENT_TYPE;

  switch (agentType) {
    case "langgraph":
      return new LangGraphAdapter({
        toolGroups: options.toolGroups,
        vectorBackend: options.vectorBackend,
        kubeconfig: options.kubeconfig,
      });

    case "vercel":
      return new VercelAgent({
        toolGroups: options.toolGroups,
        vectorBackend: options.vectorBackend,
        kubeconfig: options.kubeconfig,
      });

    default: {
      // Exhaustive check — TypeScript will error if a new AgentType is added
      // without handling it here
      const _exhaustive: never = agentType;
      throw new Error(`Unknown agent type: ${_exhaustive}`);
    }
  }
}
