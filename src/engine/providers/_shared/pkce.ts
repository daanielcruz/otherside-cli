import { createPkcePair, type PkcePair } from "@/kernel/mcp/oauth/pkce.ts";

export type { PkcePair } from "@/kernel/mcp/oauth/pkce.ts";

/** Default loopback PKCE verifier entropy (bytes). */
export const DEFAULT_PKCE_VERIFIER_BYTES = 32;

export async function generatePkce(
  verifierBytes: number = DEFAULT_PKCE_VERIFIER_BYTES,
): Promise<PkcePair> {
  return createPkcePair(verifierBytes);
}
