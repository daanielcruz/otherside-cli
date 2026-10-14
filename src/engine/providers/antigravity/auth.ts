import type { FinalizeLoginResult, ValidationHandler } from "@/engine/contract/login.ts";
import type { AuthStrategy } from "@/engine/contract/types.ts";
import { parseWireError } from "@/engine/providers/_shared/error-wire.ts";
import { buildOauthAuthStrategy } from "@/engine/providers/_shared/oauth/auth-strategy.ts";
import { type PkceFlowHandle, runPkceFlow } from "@/engine/providers/_shared/oauth/handle.ts";
import { backendHost, userAgent } from "@/engine/providers/antigravity/fingerprint.ts";
import { callCodeAssist, replyJson } from "@/engine/providers/antigravity/rpc.ts";
import { openBrowser } from "@/kernel/std/browser.ts";
import { AccountVerificationError } from "@/kernel/std/types/error-meta.ts";
import { type GoogleOauthTokens, loadFor, saveFor } from "@/kernel/storage/credentials.ts";

const REFRESH_SAFETY_MARGIN_MS = 60_000;
const DEFAULT_EXPIRES_IN_SEC = 3600;

const CLIENT_ID = "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com";
const CLIENT_SECRET = "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";

const AUTH_URL = "https://accounts.google.com/o/oauth2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo";

const SCOPES = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/aicode",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
];

const PORT_START = 54565;
const PORT_END = PORT_START + 64;
const CALLBACK_PATH = "/callback";
const PROVIDER_LABEL = "Antigravity";

const PROJECT_ENV_VARS = [
  "OTHERSIDE_ANTIGRAVITY_PROJECT",
  "GOOGLE_CLOUD_PROJECT",
  "GCLOUD_PROJECT",
];

export const LOAD_CODE_ASSIST_PATH = "/v1internal:loadCodeAssist";
const ONBOARD_USER_PATH = "/v1internal:onboardUser";
const ANTIGRAVITY_IDE_TYPE = "ANTIGRAVITY";
const VALIDATION_REQUIRED_CODE = "VALIDATION_REQUIRED";
const FREE_TIER_ID = "free-tier";
const VERIFY_ACCOUNT_MESSAGE = "Verify your account to continue.";
const ONBOARD_POLL_ATTEMPTS = 20;
const ONBOARD_POLL_INTERVAL_MS = 2000;
export const CODE_ASSIST_METADATA = { ideType: ANTIGRAVITY_IDE_TYPE };

interface GoogleTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
  id_token?: string;
}

interface GoogleUserinfo {
  email?: string;
  hd?: string;
}

function envProjectId(): string | undefined {
  for (const key of PROJECT_ENV_VARS) {
    const v = process.env[key]?.trim();
    if (v) return v;
  }
  return undefined;
}

function computeExpiresAtMs(expiresInSec: number | undefined): number {
  const secs = typeof expiresInSec === "number" ? expiresInSec : DEFAULT_EXPIRES_IN_SEC;
  return Date.now() + secs * 1000;
}

async function postForm(form: Record<string, string>): Promise<GoogleTokenResponse> {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(form)) body.set(k, v);
  const resp = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`antigravity token endpoint ${resp.status}: ${text}`);
  }
  return (await resp.json()) as GoogleTokenResponse;
}

async function fetchUserinfo(accessToken: string): Promise<GoogleUserinfo | null> {
  try {
    const resp = await fetch(USERINFO_URL, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!resp.ok) return null;
    return (await resp.json()) as GoogleUserinfo;
  } catch {
    return null;
  }
}

function buildAuthorizeUrl(challenge: string, state: string, redirectUri: string): string {
  const u = new URL(AUTH_URL);
  u.searchParams.set("client_id", CLIENT_ID);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("scope", SCOPES.join(" "));
  u.searchParams.set("code_challenge", challenge);
  u.searchParams.set("code_challenge_method", "S256");
  u.searchParams.set("state", state);
  u.searchParams.set("access_type", "offline");
  u.searchParams.set("prompt", "consent");
  return u.toString();
}

interface ExchangeInput {
  code: string;
  verifier: string;
  redirectUri: string;
}

async function exchangeCode(input: ExchangeInput): Promise<GoogleOauthTokens> {
  const resp = await postForm({
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: input.redirectUri,
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    code_verifier: input.verifier,
  });
  if (!resp.refresh_token) {
    throw new Error("antigravity login: token response had no refresh_token");
  }
  const userinfo = await fetchUserinfo(resp.access_token);
  const tokens: GoogleOauthTokens = {
    accessToken: resp.access_token,
    refreshToken: resp.refresh_token,
    expiresAt: computeExpiresAtMs(resp.expires_in),
    scopes: resp.scope ? resp.scope.split(/\s+/).filter(Boolean) : SCOPES,
  };
  if (resp.id_token) tokens.idToken = resp.id_token;
  if (userinfo?.email) tokens.email = userinfo.email;
  const project = envProjectId();
  if (project) tokens.projectId = project;
  await saveFor("antigravity", tokens);
  return tokens;
}

async function refreshTokens(prior: GoogleOauthTokens): Promise<GoogleOauthTokens> {
  const resp = await postForm({
    grant_type: "refresh_token",
    refresh_token: prior.refreshToken,
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
  });
  const next: GoogleOauthTokens = {
    ...prior,
    accessToken: resp.access_token,
    expiresAt: computeExpiresAtMs(resp.expires_in),
  };
  if (resp.scope) next.scopes = resp.scope.split(/\s+/).filter(Boolean);
  if (resp.id_token) next.idToken = resp.id_token;
  const project = envProjectId();
  if (project) next.projectId = project;
  await saveFor("antigravity", next);
  return next;
}

let activeRefreshPromise: Promise<GoogleOauthTokens> | null = null;

function tokensChanged(current: GoogleOauthTokens, prior: GoogleOauthTokens): boolean {
  return current.accessToken !== prior.accessToken || current.refreshToken !== prior.refreshToken;
}

async function executeRefresh(prior?: GoogleOauthTokens): Promise<GoogleOauthTokens> {
  try {
    const stored = await loadFor("antigravity");
    if (!stored) {
      throw new Error(
        "not logged in to antigravity — run `otherside login --provider antigravity`",
      );
    }
    // A different flow may have refreshed this persistent credential since the
    // caller observed it. Reuse that result instead of another token exchange.
    if (prior && tokensChanged(stored, prior)) return stored;
    if (stored.expiresAt - REFRESH_SAFETY_MARGIN_MS > Date.now()) return stored;
    return refreshTokens(stored);
  } finally {
    activeRefreshPromise = null;
  }
}

function runRefresh(prior?: GoogleOauthTokens): Promise<GoogleOauthTokens> {
  if (!activeRefreshPromise) activeRefreshPromise = executeRefresh(prior);
  return activeRefreshPromise;
}

export type AntigravityLoginHandle = PkceFlowHandle<GoogleOauthTokens>;

export async function beginLogin(): Promise<AntigravityLoginHandle> {
  return runPkceFlow<GoogleOauthTokens>({
    providerLabel: PROVIDER_LABEL,
    callbackPath: CALLBACK_PATH,
    portStart: PORT_START,
    portEnd: PORT_END,
    redirectUriHost: "127.0.0.1",
    buildAuthorizeUrl: ({ challenge, state, redirectUri }) =>
      buildAuthorizeUrl(challenge, state, redirectUri),
    exchange: ({ code, verifier, redirectUri }) => exchangeCode({ code, verifier, redirectUri }),
  });
}

export async function login(): Promise<GoogleOauthTokens> {
  const flow = await beginLogin();
  await openBrowser(flow.url);
  return flow.result;
}

export async function currentTokens(): Promise<GoogleOauthTokens> {
  let tokens = await loadFor("antigravity");
  if (!tokens) {
    throw new Error("not logged in to antigravity — run `otherside login --provider antigravity`");
  }
  if (tokens.expiresAt - REFRESH_SAFETY_MARGIN_MS <= Date.now()) {
    tokens = await runRefresh(tokens);
  }
  return tokens;
}

export async function authorizationHeader(): Promise<string> {
  const tokens = await currentTokens();
  return `Bearer ${tokens.accessToken}`;
}

interface CodeAssistTier {
  id?: string;
  /** An ineligible tier names itself by `tierId`; an allowed one by `id`. */
  tierId?: string;
  isDefault?: boolean;
  userDefinedCloudaicompanionProject?: boolean;
  reasonCode?: string;
  reasonMessage?: string;
  validationUrl?: string;
}

interface LoadCodeAssistResponse {
  cloudaicompanionProject?: string;
  allowedTiers?: CodeAssistTier[];
  ineligibleTiers?: CodeAssistTier[];
}

interface OnboardOperation {
  name?: string;
  done?: boolean;
  response?: { cloudaicompanionProject?: { id?: string } };
}

class ChangeAuthRequestedError extends Error {
  constructor() {
    super("antigravity: user requested a different account");
    this.name = "ChangeAuthRequestedError";
  }
}

class ValidationCancelledError extends Error {
  constructor() {
    super("antigravity: account validation cancelled");
    this.name = "ValidationCancelledError";
  }
}

export function codeAssistHeaders(accessToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    "User-Agent": userAgent(),
    "Content-Type": "application/json",
    "Accept-Encoding": "gzip",
  };
}

/** The account must be verified before the backend serves it: why, and the page that does it. */
interface AccountVerification {
  url: string;
  message: string;
  /** The account is refused for a reason verifying cannot lift. */
  ineligible?: true;
}

type CodeAssistLoad =
  | { kind: "loaded"; response: LoadCodeAssistResponse }
  | { kind: "verify"; verification: AccountVerification };

async function loadCodeAssist(accessToken: string): Promise<CodeAssistLoad | null> {
  try {
    const resp = await callCodeAssist({
      url: `${backendHost()}${LOAD_CODE_ASSIST_PATH}`,
      accessToken,
      body: { metadata: CODE_ASSIST_METADATA },
    });
    if (!resp.ok) {
      const parsed = parseWireError(resp.text);
      if (!parsed.verificationUrl) return null;
      const message = parsed.message || VERIFY_ACCOUNT_MESSAGE;
      return { kind: "verify", verification: { url: parsed.verificationUrl, message } };
    }
    const response = replyJson(resp) as LoadCodeAssistResponse | null;
    if (!response) return null;
    return { kind: "loaded", response };
  } catch {
    return null;
  }
}

function defaultOnboardTier(tiers: CodeAssistTier[] | undefined): CodeAssistTier | null {
  if (!tiers || tiers.length === 0) return null;
  return tiers.find((tier) => tier.isDefault === true) ?? tiers[0] ?? null;
}

/**
 * The verification an account needs before it is served: a tier flagged as needing it,
 * or a free tier the account may not use while no free tier is on offer. The latter
 * may carry no page to verify at, only the reason.
 */
function accountVerification(response: LoadCodeAssistResponse): AccountVerification | null {
  const ineligible = response.ineligibleTiers ?? [];
  const flagged = ineligible.find(
    (tier) => tier.reasonCode === VALIDATION_REQUIRED_CODE && tier.validationUrl,
  );
  if (flagged?.validationUrl) {
    return { url: flagged.validationUrl, message: flagged.reasonMessage ?? VERIFY_ACCOUNT_MESSAGE };
  }
  if (response.allowedTiers?.some((tier) => tier.id === FREE_TIER_ID)) return null;
  const freeTier = ineligible.find((tier) => tier.tierId === FREE_TIER_ID);
  if (!freeTier?.reasonMessage) return null;
  return {
    url: freeTier.validationUrl ?? "",
    message: freeTier.reasonMessage,
    ...(freeTier.reasonCode !== undefined && freeTier.reasonCode !== VALIDATION_REQUIRED_CODE
      ? { ineligible: true as const }
      : {}),
  };
}

/** Hands a verification to the user and returns once they report it done. */
async function verifyAccount(
  verification: AccountVerification,
  onValidation: ValidationHandler | undefined,
): Promise<void> {
  if (!verification.url || !onValidation) {
    throw new AccountVerificationError({
      provider: "antigravity",
      reason: verification.message,
      verificationUrl: verification.url,
      ...(verification.ineligible ? { ineligible: true } : {}),
    });
  }
  const intent = await onValidation(verification.url, verification.message);
  if (intent === "verify") return;
  if (intent === "change_auth") throw new ChangeAuthRequestedError();
  throw new ValidationCancelledError();
}

async function pollOnboardOperation(
  accessToken: string,
  operationName: string,
): Promise<string | null> {
  const url = `${backendHost()}/${operationName}`;
  for (let attempt = 0; attempt < ONBOARD_POLL_ATTEMPTS; attempt++) {
    try {
      const resp = await callCodeAssist({ url, accessToken });
      const op = replyJson(resp) as OnboardOperation | null;
      if (op?.done === true) {
        const id = op.response?.cloudaicompanionProject?.id?.trim();
        return id && id.length > 0 ? id : null;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, ONBOARD_POLL_INTERVAL_MS));
  }
  return null;
}

async function onboardUser(accessToken: string, tierId: string): Promise<string | null> {
  try {
    const resp = await callCodeAssist({
      url: `${backendHost()}${ONBOARD_USER_PATH}`,
      accessToken,
      body: { tierId, metadata: CODE_ASSIST_METADATA },
    });
    if (!resp.ok) return null;
    const op = replyJson(resp) as OnboardOperation | null;
    if (!op?.name) return null;
    return await pollOnboardOperation(accessToken, op.name);
  } catch {
    return null;
  }
}

async function discoverProjectId(
  accessToken: string,
  onValidation?: ValidationHandler,
): Promise<string | null> {
  while (true) {
    const load = await loadCodeAssist(accessToken);
    if (!load) return null;
    if (load.kind === "verify") {
      await verifyAccount(load.verification, onValidation);
      continue;
    }
    const { response } = load;
    const existing = response.cloudaicompanionProject?.trim();
    if (existing && existing.length > 0) return existing;
    const verification = accountVerification(response);
    if (verification) {
      await verifyAccount(verification, onValidation);
      continue;
    }
    const tier = defaultOnboardTier(response.allowedTiers);
    if (!tier?.id) return null;
    if (tier.userDefinedCloudaicompanionProject === true) return null;
    return onboardUser(accessToken, tier.id);
  }
}

export async function resolveProjectId(
  tokens: GoogleOauthTokens,
  onValidation?: ValidationHandler,
): Promise<string> {
  const fromEnv = envProjectId();
  if (fromEnv) return fromEnv;
  if (tokens.projectId && tokens.projectId.length > 0) return tokens.projectId;
  const discovered = await discoverProjectId(tokens.accessToken, onValidation);
  if (discovered) {
    await saveFor("antigravity", { ...tokens, projectId: discovered });
    return discovered;
  }
  throw new Error(
    "antigravity: could not resolve a GCP project id. CloudCode loadCodeAssist returned none — " +
      "set $OTHERSIDE_ANTIGRAVITY_PROJECT (or $GOOGLE_CLOUD_PROJECT) explicitly.",
  );
}

export async function finalizeLogin(opts: {
  onValidation: ValidationHandler;
}): Promise<FinalizeLoginResult> {
  const tokens = await currentTokens();
  try {
    await resolveProjectId(tokens, opts.onValidation);
    return "ok";
  } catch (err) {
    if (err instanceof ChangeAuthRequestedError) return "change_auth";
    throw err;
  }
}

export const Auth: AuthStrategy = buildOauthAuthStrategy<GoogleOauthTokens>({
  providerId: "antigravity",
  refresh: (tokens) => runRefresh(tokens),
});
