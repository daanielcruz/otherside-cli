import type { SlashCommand } from "@/commands/catalog.ts";
import type { SlashContext, SlashResult } from "@/commands/types.ts";
import {
  findServerPrompt,
  mcpClientForServer,
  promptArguments,
  promptText,
} from "@/engine/mcp/prompts.ts";

/**
 * Running a prompt a server offers.
 *
 * The prompt IS the turn: what the server returns is submitted the way a typed
 * message is, so the command runs in one press rather than two. Nothing is
 * submitted unless the server answered with words — a refusal, a timeout or an
 * empty answer is told to the reader instead, since a turn opened on nothing
 * costs a request and says nothing.
 */
export async function handleServerPrompt(
  cmd: SlashCommand,
  args: string,
  _ctx: SlashContext,
): Promise<SlashResult> {
  const prompt = findServerPrompt(cmd.name);
  if (!prompt) {
    return { kind: "unknown", feedback: `${cmd.name} is no longer offered by its server.` };
  }

  let text: string;
  try {
    const client = mcpClientForServer(prompt.server);
    if (!client) {
      return { kind: "instant", command: cmd, feedback: `${prompt.server} is not connected.` };
    }
    text = promptText(await client.getPrompt(prompt.name, promptArguments(prompt, args)));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { kind: "instant", command: cmd, feedback: `${cmd.name} failed: ${detail}` };
  }

  if (text.length === 0) {
    return { kind: "instant", command: cmd, feedback: `${cmd.name} returned nothing to send.` };
  }
  // No feedback: the turn is the outcome, and a line saying so would stand
  // between the command and its own answer.
  return { kind: "instant", command: cmd, shouldQuery: true, queryText: text };
}
