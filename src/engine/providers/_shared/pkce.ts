import { createPkcePair, type PkcePair } from "@/kernel/mcp/oauth/pkce.ts";

export type { PkcePair } from "@/kernel/mcp/oauth/pkce.ts";

export async function generatePkce(): Promise<PkcePair> {
  return createPkcePair(32);
}
