#!/usr/bin/env node
/**
 * index.ts - CLI entry point for cluster-whisperer
 *
 * What this file does:
 * This is the main entry point when you run the cluster-whisperer command.
 * It parses command-line arguments using Commander.js and routes to the
 * appropriate functionality.
 *
 * Current state (M1 - POC):
 * For now, this just tests the kubectl_get tool directly.
 * In M2, we'll add the agentic loop that decides which tools to call.
 *
 * The shebang (#!/usr/bin/env node):
 * This line tells the OS to run this file with Node.js.
 * It's what makes `cluster-whisperer "question"` work after npm link.
 */

import { Command } from "commander";
import { kubectlGetTool } from "./tools/kubectl-get";

/**
 * Main function - sets up the CLI and handles commands
 *
 * Why async?
 * Our tools make kubectl calls which are async operations.
 * Making main() async lets us use await for cleaner code.
 */
async function main() {
  const program = new Command();

  // Configure the CLI with name, description, and version
  // This info shows up when users run --help
  program
    .name("cluster-whisperer")
    .description(
      "AI agent that answers natural language questions about Kubernetes clusters"
    )
    .version("0.1.0");

  // Define the main command - takes a question as an argument
  // The angle brackets <question> mean it's required
  program
    .argument("<question>", "Natural language question about your cluster")
    .action(async (question: string) => {
      console.log(`\nQuestion: ${question}\n`);

      // M1: Test kubectl_get directly
      // In M2, this will be replaced with the agentic loop that decides
      // which tools to call based on the question
      console.log("--- M1 Test Mode: Calling kubectl_get directly ---\n");

      // For testing, we'll list pods across all namespaces
      // This proves the tool works end-to-end
      console.log("Testing kubectl_get tool with: get pods in all namespaces");
      console.log("-".repeat(50));

      const result = await kubectlGetTool.invoke({
        resource: "pods",
        namespace: "all",
      });

      console.log(result);
      console.log("-".repeat(50));
      console.log(
        "\nM1 complete: kubectl_get tool is working."
      );
      console.log(
        "Next milestone (M2): Add agentic loop to answer questions.\n"
      );
    });

  // Parse command line arguments and execute
  await program.parseAsync(process.argv);
}

// Run the main function and handle any top-level errors
main().catch((error) => {
  console.error("Error:", error.message);
  process.exit(1);
});
