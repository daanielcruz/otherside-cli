import { describe, expect, it } from "bun:test";
import { normalizeLoginProvider } from "@/engine/contract/login.ts";
import { Auth as inferenceAuth } from "@/engine/providers/anthropic/auth.ts";
import { Auth } from "../auth.ts";
import { config } from "../config.ts";
import cloud from "../index.ts";
import { translateRequestCloud } from "../translate.ts";

describe("Cloud provider registration", () => {
  it("exposes an independent OAuth login and only Opus 5.5", () => {
    expect(normalizeLoginProvider("anthropic-cloud")).toBe("anthropic-cloud");
    expect(cloud.beginLogin().kind).toBe("oauth_pkce");
    expect(cloud.defaultModels().map((model) => model.id)).toEqual(["claude-opus-5-5"]);
    expect(cloud.defaultModelId()).toBe("claude-opus-5-5");
    expect(cloud.defaultModels()[0]?.provider).toBe("anthropic-cloud");
    expect(cloud.featureFlags().supportsImages).toBe(true);
    expect(config.provider.api).toBe("cloud-sessions");
  });

  it.each([
    null,
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ] as const)("resolves effort %s without changing the catalog default", (effort) => {
    const request = translateRequestCloud(
      {
        provider: "anthropic-cloud",
        model: "claude-opus-5-5",
        effort,
        cwd: ".",
        sessionId: "effort-session",
        permissionMode: "default",
      },
      [],
      [],
    );
    expect(request.effort).toBe(effort ?? "high");
    expect(cloud.defaultModels()[0]?.defaultEffort).toBe("high");
    expect(cloud.fallbackEfforts().default).toBe("high");
  });

  it("uses the configured adapter retry decision without a generic provider override", () => {
    if (!config.recoverableError) throw new Error("Cloud adapter retry handler is required");
    expect(cloud.recoverableError).toBe(config.recoverableError);
  });

  it("uses its own auth strategy rather than inference credentials", () => {
    expect(config.auth).toBe(Auth);
    expect(config.auth).not.toBe(inferenceAuth);
  });
});
