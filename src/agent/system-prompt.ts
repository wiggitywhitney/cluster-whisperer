// ABOUTME: Loads the investigator system prompt and strips sections for inactive tool groups.
// ABOUTME: Sections tagged with <!-- tools:group --> ... <!-- /tools:group --> are removed when that group is inactive.

/**
 * system-prompt.ts - System prompt loading with tool-group filtering
 *
 * The investigator system prompt contains sections specific to each tool group
 * (vector search, kubectl apply). When an agent runs with a subset of tools —
 * for example, kubectl-only during the first act of a demo — those sections
 * would otherwise cause the agent to reason about tools it doesn't have:
 *
 *   "I should use vector_search first... but I don't see it in my available tools."
 *
 * This module strips inactive sections before the prompt reaches the agent, so
 * the agent only sees instructions for tools it actually has access to.
 *
 * Tagging syntax in investigator.md:
 *
 *   <!-- tools:vector -->
 *   ...content only shown when vector tools are active...
 *   <!-- /tools:vector -->
 *
 * How it works:
 * - buildSystemPrompt reads investigator.md and calls stripInactiveSections
 * - stripInactiveSections loops over all known tool groups
 * - For inactive groups: removes the entire tagged block (tags + content)
 * - For active groups: removes only the tag markers, keeps the content
 * - Collapses extra blank lines left by removed blocks
 */

import * as fs from "fs";
import * as path from "path";
import { VALID_TOOL_GROUPS, type ToolGroup } from "../tools/tool-groups";

/**
 * Path to the system prompt file, resolved relative to this compiled file's
 * location (src/agent → project root → prompts/).
 */
const promptPath = path.join(__dirname, "../../prompts/investigator.md");

/**
 * Cached raw prompt file content — loaded lazily on first call.
 * The raw content is cached separately from the stripped result because
 * different tool group configurations produce different stripped prompts.
 */
let rawPromptCache: string | null = null;

function loadRawPrompt(): string {
  if (!rawPromptCache) {
    try {
      rawPromptCache = fs.readFileSync(promptPath, "utf8");
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Could not load system prompt from ${promptPath}. ` +
          `Make sure prompts/investigator.md exists in the project root. ` +
          `(${detail})`
      );
    }
  }
  return rawPromptCache;
}

/**
 * Strips tagged sections for inactive tool groups from a raw prompt string.
 *
 * This is a pure function exported separately from buildSystemPrompt so it
 * can be tested without reading from disk.
 *
 * Tagging convention:
 *   <!-- tools:groupname -->
 *   ...content for that group...
 *   <!-- /tools:groupname -->
 *
 * @param rawPrompt - The raw prompt text with optional tool-group tags
 * @param toolGroups - The tool groups that are currently active
 * @returns The prompt with inactive sections removed and tags cleaned up
 */
export function stripInactiveSections(
  rawPrompt: string,
  toolGroups: ToolGroup[]
): string {
  let result = rawPrompt;

  for (const group of VALID_TOOL_GROUPS) {
    const openTag = `<!-- tools:${group} -->`;
    const closeTag = `<!-- /tools:${group} -->`;

    if (!toolGroups.includes(group)) {
      // Remove the entire section (tags + content).
      // The \n? patterns absorb the newline that typically follows each tag line
      // so we don't leave a blank line where the section was.
      const sectionRegex = new RegExp(
        `\\n?${openTag}\\n?[\\s\\S]*?${closeTag}\\n?`,
        "g"
      );
      // Replace with "\n" (not "") so surrounding paragraphs keep their separator.
      // The \n{3,} cleanup below handles any extra blank lines.
      result = result.replace(sectionRegex, "\n");
    } else {
      // Keep the content but strip the tag markers themselves.
      result = result.replace(new RegExp(`${openTag}\\n?`, "g"), "");
      result = result.replace(new RegExp(`${closeTag}\\n?`, "g"), "");
    }
  }

  // Collapse three or more consecutive newlines into two (a single blank line).
  // This cleans up gaps left when sections are removed between paragraphs.
  result = result.replace(/\n{3,}/g, "\n\n");

  return result.trim();
}

/**
 * Builds the system prompt filtered to the active tool groups.
 *
 * Reads investigator.md (cached after first read) and strips any sections
 * tagged for tool groups that are not in the active set.
 *
 * @param toolGroups - The tool groups that are currently active
 * @returns The filtered system prompt string
 */
export function buildSystemPrompt(toolGroups: ToolGroup[]): string {
  return stripInactiveSections(loadRawPrompt(), toolGroups);
}
