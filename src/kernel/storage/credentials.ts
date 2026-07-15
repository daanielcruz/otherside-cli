import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { credentialsPath } from "@/kernel/std/fs/paths.ts";
import { chmodIfPosix, renameReplaceSync } from "@/kernel/std/fs/secure-fs.ts";

export { credentialsPath };

export interface AnthropicTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scopes?: string[];
  subscriptionType?: string;
  rateLimitTier?: string;
  accountEmail?: string;
  accountUuid?: string;
  organizationName?: string;
}

export interface CodexTokens {
  accessToken: string;
  refreshToken: string;
  idToken?: string;
  accountId?: string;
  expiresAt: number;
  scopes?: string[];
  installationId?: string;
  windowId?: string;
}

export interface XaiTokens {
  accessToken: string;
  refreshToken: string;
  idToken?: string;
  accountId?: string;
  expiresAt: number;
  scopes?: string[];
}

export interface KimiCreds {
  apiKey: string;
}

export interface DeepseekCreds {
  apiKey: string;
}

export interface MinimaxCreds {
  apiKey: string;
  plan?: string;
}

export interface GlmUserInfo {
  user_id?: string;
  email?: string;
  avatar?: string;
  name?: string;
}

export interface GlmCreds {
  zcodeJwtToken?: string;
  zaiAccessToken?: string;
  user?: GlmUserInfo;
  expiresAt?: number;
  plan?: string;
  apiKey?: string;
}

export interface GoogleOauthTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scopes?: string[];
  email?: string;
  projectId?: string;
  idToken?: string;
}

export interface OpenAiCustomCreds {
  apiKey: string;
  baseUrl: string;
  model?: string;
  contextWindow?: number;
  outputTokenLimit?: number;
}

export interface CredentialsBundle {
  anthropic?: AnthropicTokens;
  "anthropic-oauth"?: AnthropicTokens;
  codex?: CodexTokens;
  "codex-oauth"?: CodexTokens;
  xai?: XaiTokens;
  deepseek?: DeepseekCreds;
  "kimi-code"?: KimiCreds;
  kimi?: KimiCreds;
  minimax?: MinimaxCreds;
  glm?: GlmCreds;
  antigravity?: GoogleOauthTokens;
  "openai-custom"?: OpenAiCustomCreds;
}

export type ProviderSlug =
  | "anthropic"
  | "antigravity"
  | "codex"
  | "deepseek"
  | "glm"
  | "xai"
  | "kimi-code"
  | "minimax"
  | "openai-custom";

type CredentialSlug = ProviderSlug;
type AnyCredential = CredentialsBundle[keyof CredentialsBundle];

export function hasCredential(bundle: CredentialsBundle | null, slug: ProviderSlug): boolean {
  if (!bundle) return false;
  if (slug === "anthropic") return Boolean(bundle.anthropic || bundle["anthropic-oauth"]);
  if (slug === "codex") return Boolean(bundle.codex || bundle["codex-oauth"]);
  if (slug === "kimi-code") return Boolean(bundle["kimi-code"] || bundle.kimi);
  if (slug === "glm") return Boolean(bundle.glm?.zcodeJwtToken);
  return Boolean(bundle[slug]);
}

export function hasConfiguredCredential(
  bundle: CredentialsBundle | null,
  slug: ProviderSlug,
): boolean {
  if (hasCredential(bundle, slug)) return true;
  if (slug === "deepseek") return hasNonEmptyEnv("OTHERSIDE_DEEPSEEK_API_KEY", "DEEPSEEK_API_KEY");
  if (slug === "kimi-code") return hasNonEmptyEnv("OTHERSIDE_KIMI_API_KEY", "KIMI_API_KEY");
  if (slug === "minimax") return hasNonEmptyEnv("OTHERSIDE_MINIMAX_API_KEY", "MINIMAX_API_KEY");
  if (slug === "glm") return hasCredential(bundle, slug);
  if (slug === "openai-custom") {
    return hasNonEmptyEnv(
      "OTHERSIDE_OPENAI_API_KEY",
      "OPENAI_API_KEY",
      "OTHERSIDE_OPENAI_BASE_URL",
    );
  }
  return false;
}

function hasNonEmptyEnv(...keys: string[]): boolean {
  return keys.some((key) => (process.env[key]?.trim() ?? "").length > 0);
}

export function hasCodexCredentialSync(): boolean {
  const path = credentialsPath();
  if (!existsSync(path)) return false;
  try {
    const all = JSON.parse(readFileSync(path, "utf8")) as Partial<CredentialsBundle>;
    const tokens = all.codex ?? all["codex-oauth"];
    return Boolean(tokens?.accessToken);
  } catch {
    return false;
  }
}

export const PROVIDER_FALLBACK_ORDER: ProviderSlug[] = [
  "anthropic",
  "codex",
  "xai",
  "kimi-code",
  "deepseek",
  "minimax",
  "glm",
  "openai-custom",
];

export function firstLoggedProvider(
  bundle: CredentialsBundle | null,
  exclude?: ProviderSlug,
): ProviderSlug | null {
  if (!bundle) return null;
  for (const slug of PROVIDER_FALLBACK_ORDER) {
    if (slug === exclude) continue;
    if (hasCredential(bundle, slug)) return slug;
  }
  return null;
}

export async function loadAll(): Promise<CredentialsBundle> {
  const file = Bun.file(credentialsPath());
  if (!(await file.exists())) return {};
  try {
    const all = (await file.json()) as CredentialsBundle & { grok?: unknown };
    if (all.grok !== undefined && all.xai === undefined) {
      all.xai = all.grok as XaiTokens;
      delete all.grok;
      const path = credentialsPath();
      mkdirSync(dirname(path), { recursive: true });
      const tmp = `${path}.tmp.${Date.now()}`;
      await Bun.write(tmp, JSON.stringify(all, null, 2));
      chmodIfPosix(tmp, 0o600);
      renameReplaceSync(tmp, path);
    }
    return all;
  } catch {
    return {};
  }
}

export async function loadFor<S extends CredentialSlug>(
  slug: S,
): Promise<CredentialsBundle[S] | null> {
  const all = await loadAll();
  for (const key of storageKeys(slug)) {
    const value = all[key];
    if (value) return value as CredentialsBundle[S];
  }
  return null;
}

export async function saveFor<S extends CredentialSlug>(
  slug: S,
  value: CredentialsBundle[S],
): Promise<void> {
  const path = credentialsPath();
  mkdirSync(dirname(path), { recursive: true });
  const all = await loadAll();
  const keys = storageKeys(slug);
  const primary = keys[0];
  const aliases = keys.slice(1);
  const writable = all as Record<keyof CredentialsBundle, AnyCredential>;
  writable[primary] = value;
  for (const alias of aliases) delete writable[alias];
  const tmp = `${path}.tmp.${Date.now()}`;
  await Bun.write(tmp, JSON.stringify(all, null, 2));
  chmodIfPosix(tmp, 0o600);
  renameReplaceSync(tmp, path);
}

export async function deleteFor(slug: ProviderSlug): Promise<void> {
  const path = credentialsPath();
  mkdirSync(dirname(path), { recursive: true });
  const all = await loadAll();
  for (const key of storageKeys(slug)) delete all[key];
  const tmp = `${path}.tmp.${Date.now()}`;
  await Bun.write(tmp, JSON.stringify(all, null, 2));
  chmodIfPosix(tmp, 0o600);
  renameReplaceSync(tmp, path);
}

function storageKeys(
  slug: CredentialSlug,
): [keyof CredentialsBundle, ...(keyof CredentialsBundle)[]] {
  if (slug === "anthropic") return ["anthropic", "anthropic-oauth"];
  if (slug === "codex") return ["codex", "codex-oauth"];
  if (slug === "kimi-code") return ["kimi-code", "kimi"];
  return [slug];
}
