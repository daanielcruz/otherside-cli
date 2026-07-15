import type { AuthCredentials, AuthStrategy } from "@/engine/contract/types.ts";
import { type PkceFlowHandle, runPkceFlow } from "@/engine/providers/_shared/oauth/handle.ts";
import { openBrowser } from "@/kernel/std/browser.ts";
import { type GlmCreds, type GlmUserInfo, loadFor, saveFor } from "@/kernel/storage/credentials.ts";
import {
  CLIENT_ID,
  OAUTH_AUTHORIZE_URL,
  OAUTH_CALLBACK_PATH,
  OAUTH_PORT_START,
  OAUTH_PROVIDER,
  OAUTH_TOKEN_URL,
  ZAI_API_KEY_NAME,
  ZAI_BIZ_API_KEYS_BASE,
  ZAI_BIZ_CUSTOMER_URL,
  ZAI_BIZ_LOGIN_URL,
  ZCODE_AUTH_REFRESH_MARGIN_MS,
} from "./fingerprint.ts";

interface ZcodeTokenResponse {
  code?: number;
  msg?: string;
  data?: {
    token?: string;
    user?: GlmUserInfo;
    zai?: {
      access_token?: string;
    };
  };
}

interface CallbackResult {
  code: string;
  state: string;
  redirectUri: string;
}

export type GlmLoginHandle = PkceFlowHandle<GlmCreds>;

function decodeJwtPayload(jwt: string): Record<string, unknown> | null {
  const segment = jwt.split(".")[1];
  if (!segment) return null;
  const padded = segment + "=".repeat((4 - (segment.length % 4)) % 4);
  try {
    const normalized = padded.replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(Buffer.from(normalized, "base64").toString("utf8")) as Record<
      string,
      unknown
    >;
  } catch {
    return null;
  }
}

function jwtExpiresAt(jwt: string): number | undefined {
  const exp = decodeJwtPayload(jwt)?.exp;
  if (typeof exp !== "number" || !Number.isFinite(exp)) return undefined;
  return Math.floor(exp) * 1000;
}

function buildAuthorizeUrl(state: string, redirectUri: string): string {
  const url = new URL(OAUTH_AUTHORIZE_URL);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("state", state);
  return url.toString();
}

function withExpiry(creds: GlmCreds): GlmCreds {
  const expiresAt =
    creds.expiresAt ?? (creds.zaiAccessToken ? jwtExpiresAt(creds.zaiAccessToken) : undefined);
  return expiresAt ? { ...creds, expiresAt } : creds;
}

function isExpired(creds: GlmCreds): boolean {
  if (creds.apiKey?.trim()) return false;
  return !!creds.expiresAt && creds.expiresAt - ZCODE_AUTH_REFRESH_MARGIN_MS <= Date.now();
}

async function saveGlmCreds(creds: GlmCreds): Promise<GlmCreds> {
  const next = withExpiry(creds);
  await saveFor("glm", next);
  return next;
}

async function bizLogin(zaiAccessToken: string): Promise<string> {
  const resp = await fetch(ZAI_BIZ_LOGIN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: zaiAccessToken }),
  });
  const text = await resp.text().catch(() => "");
  if (!resp.ok) throw new Error(`glm biz login ${resp.status}: ${text}`);
  const parsed = JSON.parse(text) as { data?: { access_token?: string } };
  const bizToken = parsed.data?.access_token?.trim();
  if (!bizToken) throw new Error(`glm biz login returned no access_token: ${text}`);
  return bizToken;
}

interface BizOrg {
  organizationId: string;
  projects: Array<{ projectId: string }>;
}

async function resolveOrgProject(bizToken: string): Promise<{ orgId: string; projectId: string }> {
  const resp = await fetch(ZAI_BIZ_CUSTOMER_URL, {
    headers: { Authorization: `Bearer ${bizToken}` },
  });
  const text = await resp.text().catch(() => "");
  if (!resp.ok) throw new Error(`glm customer info ${resp.status}: ${text}`);
  const parsed = JSON.parse(text) as { data?: { organizations?: BizOrg[] } };
  const org = parsed.data?.organizations?.[0];
  if (!org?.organizationId) throw new Error(`glm customer info: no organization found: ${text}`);
  const project = org.projects?.[0];
  if (!project?.projectId) throw new Error(`glm customer info: no project found: ${text}`);
  return { orgId: org.organizationId, projectId: project.projectId };
}

interface ApiKeyEntry {
  apiKey: string;
  secretKey: string;
  name: string;
}

async function resolveApiKey(bizToken: string, orgId: string, projectId: string): Promise<string> {
  const base = `${ZAI_BIZ_API_KEYS_BASE}/${orgId}/projects/${projectId}/api_keys`;
  const listResp = await fetch(base, { headers: { Authorization: `Bearer ${bizToken}` } });
  const listText = await listResp.text().catch(() => "");
  if (!listResp.ok) throw new Error(`glm api_keys list ${listResp.status}: ${listText}`);
  const listParsed = JSON.parse(listText) as { data?: ApiKeyEntry[] };
  let entry = listParsed.data?.find((k) => k.name === ZAI_API_KEY_NAME);

  if (!entry) {
    const createResp = await fetch(base, {
      method: "POST",
      headers: { Authorization: `Bearer ${bizToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: ZAI_API_KEY_NAME }),
    });
    const createText = await createResp.text().catch(() => "");
    if (!createResp.ok) throw new Error(`glm api_keys create ${createResp.status}: ${createText}`);
    const createParsed = JSON.parse(createText) as { data?: ApiKeyEntry };
    entry = createParsed.data ?? undefined;
    if (!entry?.apiKey) throw new Error(`glm api_keys create returned no key: ${createText}`);
  }

  const copyResp = await fetch(`${base}/copy/${entry.apiKey}`, {
    headers: { Authorization: `Bearer ${bizToken}` },
  });
  const copyText = await copyResp.text().catch(() => "");
  if (!copyResp.ok) throw new Error(`glm api_keys copy ${copyResp.status}: ${copyText}`);
  const copyParsed = JSON.parse(copyText) as { data?: { apiKey: string; secretKey: string } };
  const fullKey = copyParsed.data;
  if (!fullKey?.apiKey || !fullKey?.secretKey) {
    throw new Error(`glm api_keys copy returned incomplete key: ${copyText}`);
  }
  return `${fullKey.apiKey}.${fullKey.secretKey}`;
}

async function resolveZaiApiKeyFromToken(zaiAccessToken: string): Promise<string> {
  const bizToken = await bizLogin(zaiAccessToken);
  const { orgId, projectId } = await resolveOrgProject(bizToken);
  return resolveApiKey(bizToken, orgId, projectId);
}

async function exchangeCode(callback: CallbackResult): Promise<GlmCreds> {
  const response = await fetch(OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      provider: OAUTH_PROVIDER,
      code: callback.code,
      redirect_uri: callback.redirectUri,
      state: callback.state,
    }),
  });
  const text = await response.text().catch(() => "");
  if (!response.ok) throw new Error(`glm oauth token exchange ${response.status}: ${text}`);
  const parsed = JSON.parse(text) as ZcodeTokenResponse;
  const token = parsed.data?.token?.trim();
  if (!token) throw new Error(`glm oauth token exchange returned no zcode token: ${text}`);
  const creds: GlmCreds = { zcodeJwtToken: token };
  const zaiAccessToken = parsed.data?.zai?.access_token?.trim();
  if (zaiAccessToken) {
    creds.zaiAccessToken = zaiAccessToken;
    creds.apiKey = await resolveZaiApiKeyFromToken(zaiAccessToken);
  }
  if (parsed.data?.user) creds.user = parsed.data.user;
  return saveGlmCreds(creds);
}

export async function beginLogin(): Promise<GlmLoginHandle> {
  return runPkceFlow<GlmCreds>({
    providerLabel: "Z.AI",
    callbackPath: OAUTH_CALLBACK_PATH,
    portStart: OAUTH_PORT_START,
    portEnd: OAUTH_PORT_START + 64,
    redirectUriHost: "127.0.0.1",
    buildAuthorizeUrl: ({ state, redirectUri }) => buildAuthorizeUrl(state, redirectUri),
    exchange: ({ code, state, redirectUri }) => exchangeCode({ code, state, redirectUri }),
  });
}

export async function login(): Promise<GlmCreds> {
  const flow = await beginLogin();
  await openBrowser(flow.url);
  return flow.result;
}

// Resolves the credential Z.AI chat/quota requests authenticate with — the
// project API key (`<apiKey>.<secretKey>`) once resolved, never the raw
// ZCode account JWT (which 401s against api.z.ai/api/anthropic/v1/messages).
export async function currentGlmChatCredential(): Promise<string> {
  const creds = await loadFor("glm");
  if (!creds?.zcodeJwtToken?.trim()) {
    throw new Error("not logged in to glm — run `otherside login --provider glm`");
  }
  if (isExpired(creds)) throw new Error("glm login expired — run `otherside login --provider glm`");
  if (creds.apiKey?.trim()) return creds.apiKey.trim();
  if (creds.zaiAccessToken?.trim()) {
    const apiKey = await resolveZaiApiKeyFromToken(creds.zaiAccessToken);
    await saveGlmCreds({ ...creds, apiKey });
    return apiKey;
  }
  return creds.zcodeJwtToken.trim();
}

export const Auth: AuthStrategy = {
  async load(): Promise<AuthCredentials | null> {
    const creds = await loadFor("glm");
    if (!creds?.zcodeJwtToken) return null;
    return creds.expiresAt
      ? { kind: "oauth", expiresAt: creds.expiresAt, raw: creds }
      : { kind: "oauth", raw: creds };
  },
  async refresh(): Promise<AuthCredentials> {
    throw new Error("glm oauth refresh is not available — run `otherside login --provider glm`");
  },
  isExpired(creds: AuthCredentials): boolean {
    const expiresAt = (creds.raw as GlmCreds).expiresAt;
    return !!expiresAt && expiresAt - ZCODE_AUTH_REFRESH_MARGIN_MS <= Date.now();
  },
};
