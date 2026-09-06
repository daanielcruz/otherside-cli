import { auxiliaryModelFor } from "@/engine/model/tier/tiers.ts";
import {
  API_MESSAGES_URL,
  anthropicWireModelId,
  fingerprint,
} from "@/engine/providers/anthropic/_infra/fingerprint.ts";
import { authorizationHeader } from "@/engine/providers/anthropic/auth.ts";
import { anthropicUserIdMetadata } from "@/engine/providers/anthropic/metadata.ts";
import { ingestAnthropicHeaders } from "@/engine/providers/anthropic/rate-limits.ts";
import { loadConfig } from "@/kernel/config/config.ts";
import { uuidv4 } from "@/kernel/std/id.ts";
import type { ProviderId } from "@/kernel/std/types/provider-ids.ts";
import type { PermissionMode, RequestContext } from "@/kernel/std/types/request.ts";
import { loadFor } from "@/kernel/storage/credentials.ts";

type QuotaProbeBroker = {
  read(): { provider: ProviderId; permissionMode: PermissionMode };
};

/**
 * Sends a background request to fetch and cache usage limits.
 */
export async function probeQuotaStatus(broker?: QuotaProbeBroker): Promise<void> {
  try {
    const provider = broker
      ? broker.read().provider
      : ((await loadConfig().catch(() => null))?.defaultProvider ?? "anthropic");

    if (provider !== "anthropic") {
      return;
    }

    const creds = await loadFor("anthropic");
    if (!creds || typeof creds !== "object" || !("accessToken" in creds) || "apiKey" in creds) {
      return;
    }

    const auth = await authorizationHeader();
    const baseModel = auxiliaryModelFor("anthropic");
    const smallFastModel = anthropicWireModelId(baseModel, false);

    const sessionId = uuidv4();
    const ctx: RequestContext = {
      provider: "anthropic",
      model: baseModel,
      effort: null,
      permissionMode: broker ? broker.read().permissionMode : "accept-edits",
      sessionId,
      cwd: process.cwd(),
      agentic: false,
    };

    const fp = fingerprint(ctx);

    const headers = {
      Authorization: auth,
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": fp.userAgent,
      ...fp.extraHeaders,
    };

    const body = {
      max_tokens: 1,
      messages: [{ role: "user", content: "quota" }],
      metadata: {
        user_id: anthropicUserIdMetadata(sessionId),
      },
      model: smallFastModel,
    };

    const resp = await fetch(API_MESSAGES_URL, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    ingestAnthropicHeaders(resp.headers);
  } catch {
    // Fail silently on errors
  }
}
