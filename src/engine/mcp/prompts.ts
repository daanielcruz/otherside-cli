import { listConnectedClients } from "@/kernel/mcp/client/registry.ts";
import type { McpPromptInfo } from "@/kernel/mcp/protocol/types.ts";
import { getActivePasteStore } from "@/kernel/std/paste/registry.ts";
import type { ImageMediaType } from "@/kernel/std/types/image.ts";

/**
 * Prompts a server offers, as commands the reader can run.
 *
 * Asking costs a round trip per server, so the roster is read when the servers
 * are and held until something says it moved — the completion list is drawn on
 * every keystroke and cannot wait on a network.
 */

export interface ServerPrompt extends McpPromptInfo {
  server: string;
}

let roster: ServerPrompt[] = [];

/** The command name for a prompt: the server, then the prompt, both namespaced. */
export function promptCommandName(server: string, prompt: string): string {
  return `${normalizeServerName(server)}:${prompt}`;
}

/** A server name as it appears in a command: no spaces, nothing to break parsing. */
export function normalizeServerName(server: string): string {
  return server.trim().replace(/[^A-Za-z0-9_-]+/g, "_");
}

export function listServerPrompts(): readonly ServerPrompt[] {
  return roster;
}

export function findServerPrompt(commandName: string): ServerPrompt | undefined {
  const wanted = commandName.toLowerCase();
  return roster.find(
    (prompt) => promptCommandName(prompt.server, prompt.name).toLowerCase() === wanted,
  );
}

/**
 * Re-reads the roster from every connected server that says it has prompts.
 * A server that fails to answer contributes nothing rather than costing the
 * others their entries.
 */
export async function refreshServerPrompts(): Promise<readonly ServerPrompt[]> {
  const next: ServerPrompt[] = [];
  for (const { name, client } of listConnectedClients()) {
    if (!offersPrompts(client.serverCapabilities())) continue;
    try {
      for (const prompt of await client.listPrompts()) next.push({ ...prompt, server: name });
    } catch {
      // The server went away or refused; its prompts are simply not on offer.
    }
  }
  roster = next;
  return roster;
}

/** The live client for a server named in a prompt command, if it is still open. */
export function mcpClientForServer(server: string) {
  return listConnectedClients().find((entry) => entry.name === server)?.client;
}

export function forgetServerPrompts(): void {
  roster = [];
}

/**
 * What a prompt expands to, in the order the server sent it.
 *
 * An image is held the way a pasted one is and stands in the text as its
 * reference, so it travels with the turn instead of being dropped for not
 * being words.
 */
export function promptText(result: unknown, hold: ImageHolder = holdInPasteStore): string {
  const messages = (result as { messages?: unknown } | null)?.messages;
  if (!Array.isArray(messages)) return "";
  const parts: string[] = [];
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    const content = (message as { content?: unknown }).content;
    for (const raw of Array.isArray(content) ? content : [content]) {
      if (!raw || typeof raw !== "object") continue;
      const block = raw as Record<string, unknown>;
      const text = block.text;
      if (typeof text === "string" && text.length > 0) {
        parts.push(text);
        continue;
      }
      const reference = imageReference(block, hold);
      if (reference !== null) parts.push(reference);
    }
  }
  return parts.join("\n\n");
}

/** Takes an image into the session's store and answers how the text names it. */
export type ImageHolder = (image: { base64: string; mediaType: ImageMediaType }) => string | null;

function imageReference(block: Record<string, unknown>, hold: ImageHolder): string | null {
  if (block.type !== "image") return null;
  const data = block.data;
  const mediaType = block.mimeType ?? block.mediaType;
  if (typeof data !== "string" || data.length === 0) return null;
  if (typeof mediaType !== "string" || !mediaType.startsWith("image/")) return null;
  return hold({ base64: data, mediaType: mediaType as ImageMediaType });
}

function holdInPasteStore(image: { base64: string; mediaType: ImageMediaType }): string | null {
  const store = getActivePasteStore();
  if (store === null) return null;
  return store.add({ type: "image", content: image.base64, mediaType: image.mediaType })
    .placeholder;
}

/** Positional arguments named by what the prompt declared, in the order it declared them. */
export function promptArguments(prompt: ServerPrompt, args: string): Record<string, string> {
  if (prompt.argumentNames.length === 0) return {};
  const written = args.trim().length === 0 ? [] : args.trim().split(/\s+/);
  const out: Record<string, string> = {};
  prompt.argumentNames.forEach((name, index) => {
    // The last declared argument takes the rest, so a trailing sentence survives.
    const isLast = index === prompt.argumentNames.length - 1;
    const value = isLast ? written.slice(index).join(" ") : (written[index] ?? "");
    if (value.length > 0) out[name] = value;
  });
  return out;
}

function offersPrompts(capabilities: { prompts?: unknown } | null): boolean {
  const prompts = capabilities?.prompts;
  return prompts === true || (typeof prompts === "object" && prompts !== null);
}
