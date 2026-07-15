export interface PkcePair {
  verifier: string;
  challenge: string;
  method: "S256";
}

export function base64UrlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function randomUrlSafe(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

export async function s256Challenge(verifier: string): Promise<string> {
  const data = new TextEncoder().encode(verifier);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return base64UrlEncode(new Uint8Array(digest));
}

export async function createPkcePair(verifierByteLength: number = 64): Promise<PkcePair> {
  const verifier = randomUrlSafe(verifierByteLength);
  const challenge = await s256Challenge(verifier);
  return { verifier, challenge, method: "S256" };
}
