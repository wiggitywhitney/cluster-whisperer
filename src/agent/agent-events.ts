// ABOUTME: Defines the AgentEvent union type — a framework-agnostic event stream for agent output.
// ABOUTME: Both LangGraph and Vercel agents emit these events so the CLI renders them identically.

/**
 * agent-events.ts - Framework-agnostic event types for agent output
 *
 * Why a shared event type?
 * The CLI needs to render agent output identically regardless of which framework
 * (LangGraph or Vercel AI SDK) produced it. Each framework has its own streaming
 * format — LangGraph emits `on_chain_stream` chunks, Vercel emits `fullStream` parts.
 * This union type abstracts over both, giving the CLI a single event model to consume.
 *
 * The four event types map to the visible CLI experience:
 * - thinking: Claude's reasoning (displayed in italic)
 * - tool_start: Agent decided to call a tool (🔧 prefix)
 * - tool_result: Tool returned a result (indented output)
 * - final_answer: Agent's conclusion (after ─── separator)
 */

/**
 * Agent is reasoning about the problem.
 * Displayed in italic so users can follow the thought process.
 */
export interface ThinkingEvent {
  type: "thinking";
  content: string;
}

/**
 * Agent decided to call a tool.
 * Displayed with 🔧 prefix showing tool name and arguments.
 */
export interface ToolStartEvent {
  type: "tool_start";
  toolName: string;
  args: Record<string, unknown>;
}

/**
 * Tool execution completed with a result.
 * Displayed indented, truncated to 1100 chars for readability.
 */
export interface ToolResultEvent {
  type: "tool_result";
  toolName: string;
  result: string;
}

/**
 * Agent produced its final answer.
 * Displayed after a separator line with "Answer:" label.
 */
export interface FinalAnswerEvent {
  type: "final_answer";
  content: string;
}

/**
 * Union of all agent event types.
 * The CLI uses a switch on event.type to render each appropriately.
 */
export type AgentEvent =
  | ThinkingEvent
  | ToolStartEvent
  | ToolResultEvent
  | FinalAnswerEvent;
