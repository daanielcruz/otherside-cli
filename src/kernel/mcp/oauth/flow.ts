import { openBrowser } from "@/kernel/std/browser.ts";
import { discoverAuthServer } from "./discovery.ts";
import { buildAuthorizeUrl, findFreePort } from "./loopback.ts";
import { createPkcePair, randomUrlSafe } from "./pkce.ts";
import { registerClient } from "./registration.ts";
import { exchangeAuthorizationCode } from "./token-endpoint.ts";
import {
  type OAuthClientCredentials,
  type OAuthDiscoveryState,
  patchOAuthRecord,
} from "./token-store.ts";

export interface OAuthFlowOptions {
  serverName: string;
  baseUrl: string;
  scope?: string;
  callbackPort?: number;
  resourceMetadataUrl?: string;
  abortSignal?: AbortSignal;
}

export type OAuthFlowOutcome =
  | { kind: "saved"; expiresAt: number }
  | { kind: "failed"; reason: string };

export interface OAuthFlowResult {
  authUrl: string;
  callbackPort: number;
  done: Promise<OAuthFlowOutcome>;
  submitCode: (input: string) => void;
}

type OAuthFlowStarter = (options: OAuthFlowOptions) => Promise<OAuthFlowResult>;
let oauthFlowStarterOverride: OAuthFlowStarter | null = null;

export function setMcpOAuthFlowStarterForTests(starter: OAuthFlowStarter | null): void {
  oauthFlowStarterOverride = starter;
}

const REDIRECT_PATH = "/oauth/callback";
const CALLBACK_TIMEOUT_MS = 10 * 60 * 1000;
const STATE_BYTE_LENGTH = 32;

export async function startOAuthFlow(options: OAuthFlowOptions): Promise<OAuthFlowResult> {
  if (oauthFlowStarterOverride) return oauthFlowStarterOverride(options);
  const metadata = await discoverAuthServer({
    serverUrl: options.baseUrl,
    resourceMetadataUrl: options.resourceMetadataUrl ?? null,
  });
  const port = options.callbackPort ?? (await findFreePort());
  const redirectUri = `http://127.0.0.1:${port}${REDIRECT_PATH}`;
  const client = await registerClient({ metadata, redirectUri, serverName: options.serverName });
  const pkce = await createPkcePair();
  const state = randomUrlSafe(STATE_BYTE_LENGTH);
  const resource = options.baseUrl;

  const discovery: OAuthDiscoveryState = {
    tokenEndpoint: metadata.tokenEndpoint,
    authorizationEndpoint: metadata.authorizationEndpoint,
    ...(metadata.registrationEndpoint
      ? { registrationEndpoint: metadata.registrationEndpoint }
      : {}),
    resource,
  };
  await patchOAuthRecord(options.serverName, { client, discovery });

  const authUrl = buildAuthorizeUrl(metadata.authorizationEndpoint, {
    response_type: "code",
    client_id: client.clientId,
    redirect_uri: redirectUri,
    state,
    code_challenge: pkce.challenge,
    code_challenge_method: pkce.method,
    resource,
    ...(options.scope ? { scope: options.scope } : {}),
  });

  const exchange: CodeExchanger = {
    tokenEndpoint: metadata.tokenEndpoint,
    client,
    verifier: pkce.verifier,
    redirectUri,
    resource,
    serverName: options.serverName,
  };

  const session = createCallbackSession({
    port,
    state,
    exchange,
    ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
  });

  openBrowser(authUrl);

  return {
    authUrl,
    callbackPort: port,
    done: session.done,
    submitCode: session.submitCode,
  };
}

interface CodeExchanger {
  tokenEndpoint: string;
  client: OAuthClientCredentials;
  verifier: string;
  redirectUri: string;
  resource: string;
  serverName: string;
}

async function redeemCode(exchange: CodeExchanger, code: string): Promise<OAuthFlowOutcome> {
  try {
    const token = await exchangeAuthorizationCode({
      tokenEndpoint: exchange.tokenEndpoint,
      client: exchange.client,
      code,
      codeVerifier: exchange.verifier,
      redirectUri: exchange.redirectUri,
      resource: exchange.resource,
    });
    await patchOAuthRecord(exchange.serverName, { token });
    return { kind: "saved", expiresAt: token.expiresAt ?? 0 };
  } catch (e) {
    return { kind: "failed", reason: (e as Error).message };
  }
}

interface CallbackSessionOptions {
  port: number;
  state: string;
  exchange: CodeExchanger;
  abortSignal?: AbortSignal;
}

interface CallbackSession {
  done: Promise<OAuthFlowOutcome>;
  submitCode: (input: string) => void;
}

function createCallbackSession(options: CallbackSessionOptions): CallbackSession {
  let settle: (outcome: OAuthFlowOutcome) => void = () => {};
  const done = new Promise<OAuthFlowOutcome>((resolve) => {
    settle = resolve;
  });
  let stopped = false;

  const server = Bun.serve({
    port: options.port,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname !== REDIRECT_PATH) {
        return new Response("not found", { status: 404 });
      }
      const code = url.searchParams.get("code");
      const callbackState = url.searchParams.get("state");
      const error = url.searchParams.get("error");
      if (error) {
        finish({ kind: "failed", reason: `authorization error: ${error}` });
        return new Response(`Authorization failed: ${error}. You can close this window.`, {
          status: 400,
        });
      }
      if (!code || callbackState !== options.state) {
        finish({ kind: "failed", reason: "missing code or state mismatch" });
        return new Response("invalid callback parameters", { status: 400 });
      }
      const outcome = await redeemCode(options.exchange, code);
      finish(outcome);
      if (outcome.kind === "saved") {
        return new Response(
          "Authorization complete. You can close this window and return to otherside.",
          { status: 200 },
        );
      }
      return new Response(`token exchange failed: ${outcome.reason}`, { status: 500 });
    },
  });

  const timer = setTimeout(
    () => finish({ kind: "failed", reason: "callback timeout" }),
    CALLBACK_TIMEOUT_MS,
  );
  const abortSignal = options.abortSignal;
  const abort = (): void => finish({ kind: "failed", reason: "aborted" });

  function stop(): void {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    abortSignal?.removeEventListener("abort", abort);
    try {
      server.stop();
    } catch {}
  }

  function finish(outcome: OAuthFlowOutcome): void {
    settle(outcome);
    stop();
  }

  function submitCode(input: string): void {
    const code = extractAuthorizationCode(input);
    if (code.length === 0) {
      finish({ kind: "failed", reason: "no authorization code found in input" });
      return;
    }
    void redeemCode(options.exchange, code).then(finish);
  }

  if (abortSignal) {
    if (abortSignal.aborted) abort();
    else abortSignal.addEventListener("abort", abort, { once: true });
  }

  return { done, submitCode };
}

function extractAuthorizationCode(input: string): string {
  const trimmed = input.trim();
  const fromQuery = trimmed.match(/[?&]code=([^&\s]+)/);
  if (fromQuery?.[1]) return decodeURIComponent(fromQuery[1]);
  return trimmed;
}
