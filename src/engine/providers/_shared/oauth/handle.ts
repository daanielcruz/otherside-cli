import { generatePkce } from "@/engine/providers/_shared/pkce.ts";
import { oauthSuccessResponse } from "@/kernel/std/oauth-success-page.ts";

export interface CallbackResult {
  code: string;
  state: string;
}

export interface ExchangeArgs {
  code: string;
  verifier: string;
  state: string;
  redirectUri: string;
  port: number;
}

export interface AuthorizeUrlArgs {
  challenge: string;
  state: string;
  redirectUri: string;
  port: number;
}

export interface PkceFlowSpec<TTokens> {
  providerLabel: string;
  callbackPath: string;
  portStart: number;
  portEnd: number;
  redirectUriHost: "localhost" | "127.0.0.1";
  buildAuthorizeUrl(args: AuthorizeUrlArgs): string;
  exchange(args: ExchangeArgs): Promise<TTokens>;
}

export interface PkceFlowHandle<TTokens> {
  url: string;
  result: Promise<TTokens>;
  submitCode(pasted: string): void;
}

export function generateState(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

interface CallbackServer {
  port: number;
  result: Promise<CallbackResult>;
  resolveExternal(r: CallbackResult): void;
  rejectExternal(e: Error): void;
}

async function awaitLoopbackCallback(opts: {
  providerLabel: string;
  callbackPath: string;
  portStart: number;
  portEnd: number;
}): Promise<CallbackServer> {
  let resolveResult!: (r: CallbackResult) => void;
  let rejectResult!: (e: Error) => void;
  const result = new Promise<CallbackResult>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });

  let chosenPort = 0;
  let server: ReturnType<typeof Bun.serve> | null = null;
  for (let port = opts.portStart; port < opts.portEnd; port++) {
    try {
      server = Bun.serve({
        port,
        hostname: "127.0.0.1",
        fetch(req: Request) {
          const url = new URL(req.url);
          if (url.pathname !== opts.callbackPath) {
            return new Response("not found", { status: 404 });
          }
          const error = url.searchParams.get("error");
          if (error) {
            rejectResult(new Error(`oauth error: ${error}`));
            return new Response(`oauth error: ${error}`, { status: 400 });
          }
          const code = url.searchParams.get("code");
          const state = url.searchParams.get("state");
          if (!code || !state) {
            rejectResult(new Error(`callback missing code/state in ${req.url}`));
            return new Response("missing code/state", { status: 400 });
          }
          resolveResult({ code, state });
          return oauthSuccessResponse(opts.providerLabel);
        },
      });
      chosenPort = port;
      break;
    } catch {}
  }
  if (!server) {
    throw new Error(
      `could not bind any port in ${opts.portStart}..${opts.portEnd} for the ${opts.providerLabel} OAuth callback`,
    );
  }
  const finalServer = server;
  const wrapped = result.finally(() => {
    setTimeout(() => finalServer.stop(true), 800);
  });
  return {
    port: chosenPort,
    result: wrapped,
    resolveExternal: resolveResult,
    rejectExternal: rejectResult,
  };
}

type ParsedSubmission = { ok: true; code: string; state: string } | { ok: false; error: string };

export function parseSubmittedCallback(pasted: string, expectedState: string): ParsedSubmission {
  const trimmed = pasted.trim();
  let code = trimmed;
  let returnedState = expectedState;
  const hashIdx = trimmed.indexOf("#");
  if (hashIdx > 0) {
    code = trimmed.slice(0, hashIdx);
    returnedState = trimmed.slice(hashIdx + 1);
  } else {
    try {
      const u = new URL(trimmed);
      const c = u.searchParams.get("code");
      const s = u.searchParams.get("state");
      if (c && s) {
        code = c;
        returnedState = s;
      }
    } catch {}
  }
  if (returnedState !== expectedState) {
    return { ok: false, error: `state mismatch: sent ${expectedState}, got ${returnedState}` };
  }
  return { ok: true, code, state: returnedState };
}

export async function runPkceFlow<TTokens>(
  spec: PkceFlowSpec<TTokens>,
): Promise<PkceFlowHandle<TTokens>> {
  const pkce = await generatePkce();
  const state = generateState();
  const callback = await awaitLoopbackCallback({
    providerLabel: spec.providerLabel,
    callbackPath: spec.callbackPath,
    portStart: spec.portStart,
    portEnd: spec.portEnd,
  });
  const redirectUri = `http://${spec.redirectUriHost}:${callback.port}${spec.callbackPath}`;
  const url = spec.buildAuthorizeUrl({
    challenge: pkce.challenge,
    state,
    redirectUri,
    port: callback.port,
  });
  const result = (async (): Promise<TTokens> => {
    const cb = await callback.result;
    if (cb.state !== state) {
      throw new Error(`state mismatch: sent ${state}, got ${cb.state}`);
    }
    return spec.exchange({
      code: cb.code,
      verifier: pkce.verifier,
      state: cb.state,
      redirectUri,
      port: callback.port,
    });
  })();
  return {
    url,
    result,
    submitCode(pasted) {
      const parsed = parseSubmittedCallback(pasted, state);
      if (!parsed.ok) {
        callback.rejectExternal(new Error(parsed.error));
        return;
      }
      callback.resolveExternal({ code: parsed.code, state: parsed.state });
    },
  };
}
