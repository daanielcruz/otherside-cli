import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import type { ProviderId } from "@/kernel/config/provider-ids.ts";
import type { CredentialsBundle } from "@/kernel/storage/credentials.ts";
import { credentialsPath } from "@/kernel/storage/credentials.ts";

// Thinking/reasoning signatures are bound to the credential that produced
// them. The fingerprint below is the stable per-account identity used to
// stamp assistant turns and to gate signature replay at request-build time.
// It must stay stable across token refreshes (never derive from access or
// refresh tokens) and must never leak raw key material into session files.

interface BundleCacheEntry {
  path: string;
  mtimeMs: number;
  size: number;
  bundle: CredentialsBundle;
}

let bundleCache: BundleCacheEntry | null = null;

function freshBundle(): CredentialsBundle {
  const path = credentialsPath();
  let mtimeMs = 0;
  let size = 0;
  try {
    const stat = statSync(path);
    mtimeMs = stat.mtimeMs;
    size = stat.size;
  } catch {
    bundleCache = null;
    return {};
  }
  if (
    bundleCache &&
    bundleCache.path === path &&
    bundleCache.mtimeMs === mtimeMs &&
    bundleCache.size === size
  ) {
    return bundleCache.bundle;
  }
  try {
    const bundle = JSON.parse(readFileSync(path, "utf8")) as CredentialsBundle;
    bundleCache = { path, mtimeMs, size, bundle };
    return bundle;
  } catch {
    return {};
  }
}

function keyDigest(material: string | undefined): string {
  if (!material) return "";
  return createHash("sha256").update(material).digest("hex").slice(0, 16);
}

function firstEnv(...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = process.env[key]?.trim();
    if (value) return value;
  }
  return undefined;
}

export function accountFingerprint(provider: ProviderId): string {
  const bundle = freshBundle();
  switch (provider) {
    case "anthropic": {
      // accountUuid only: this value is also emitted verbatim as the wire
      // metadata account_uuid, so no other field may substitute for it.
      const tokens = bundle.anthropic ?? bundle["anthropic-oauth"];
      return tokens?.accountUuid ?? "";
    }
    case "codex": {
      const tokens = bundle.codex ?? bundle["codex-oauth"];
      return tokens?.accountId ?? "";
    }
    case "xai": {
      return bundle.xai?.accountId ?? "";
    }
    case "antigravity": {
      const tokens = bundle.antigravity;
      return tokens?.email ?? tokens?.projectId ?? "";
    }
    // Env-first for api-key providers — mirrors makeApiKeyAuth.currentApiKey,
    // so the fingerprint always names the credential that signs the request.
    case "deepseek":
      return keyDigest(
        firstEnv("OTHERSIDE_DEEPSEEK_API_KEY", "DEEPSEEK_API_KEY") ?? bundle.deepseek?.apiKey,
      );
    case "kimi-code":
      return keyDigest(
        firstEnv("OTHERSIDE_KIMI_API_KEY", "KIMI_API_KEY") ??
          (bundle["kimi-code"] ?? bundle.kimi)?.apiKey,
      );
    case "minimax":
      return keyDigest(
        firstEnv("OTHERSIDE_MINIMAX_API_KEY", "MINIMAX_API_KEY") ?? bundle.minimax?.apiKey,
      );
    case "glm":
      return (
        bundle.glm?.user?.user_id ?? bundle.glm?.user?.email ?? keyDigest(bundle.glm?.zcodeJwtToken)
      );
    case "openai-custom":
      return keyDigest(
        firstEnv("OTHERSIDE_OPENAI_API_KEY", "OPENAI_API_KEY") ?? bundle["openai-custom"]?.apiKey,
      );
    default:
      return "";
  }
}

// Strict equality with unknown treated as its own identity: two unknowns
// match (a credential with no resolvable identity must keep replaying its own
// live-turn thinking — dropping it breaks tool loops), while an unstamped
// legacy block never matches a known current account and still drops.
export function sameAccountFingerprint(
  producedAccount: string | undefined,
  currentAccount: string | undefined,
): boolean {
  return (producedAccount ?? "") === (currentAccount ?? "");
}
