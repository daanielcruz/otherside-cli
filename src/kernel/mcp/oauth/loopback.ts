const PORT_RANGE_START = 49152;
const PORT_RANGE_SIZE = 16383;
const MAX_PORT_ATTEMPTS = 16;

export async function findFreePort(): Promise<number> {
  for (let attempt = 0; attempt < MAX_PORT_ATTEMPTS; attempt++) {
    const port = PORT_RANGE_START + Math.floor(Math.random() * PORT_RANGE_SIZE);
    try {
      const probe = Bun.serve({ port, hostname: "127.0.0.1", fetch: () => new Response("") });
      probe.stop();
      return port;
    } catch {}
  }
  throw new Error("no free port available for OAuth callback");
}

export function buildAuthorizeUrl(endpoint: string, params: Record<string, string>): string {
  const url = new URL(endpoint);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}
