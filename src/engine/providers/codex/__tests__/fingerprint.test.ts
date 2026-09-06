import { describe, expect, it } from "bun:test";
import {
  BETA_FEATURES,
  buildHeaders,
  CODEX_APP_VERSION,
  CODEX_CLI_VERSION,
  ORIGINATOR_HTTP,
  routingHint,
} from "@/engine/providers/codex/fingerprint.ts";
import { buildCodexRequestMetadata } from "@/engine/providers/codex/metadata.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";

/**
 * Header names the responses upgrade carries, as captured on the live wire.
 * `Host` is set by the socket pool and `sec-websocket-extensions` is written by
 * the websocket library when it offers permessage-deflate, so neither is built here.
 */
const UPGRADE_HEADERS_FROM_TRANSPORT = ["Host", "sec-websocket-extensions"] as const;

const UPGRADE_HEADERS = [
  "authorization",
  "chatgpt-account-id",
  "connection",
  "host",
  "openai-beta",
  "originator",
  "sec-websocket-extensions",
  "sec-websocket-key",
  "sec-websocket-version",
  "session-id",
  "thread-id",
  "upgrade",
  "user-agent",
  "version",
  "x-client-request-id",
  "x-codex-beta-features",
  "x-codex-routing-hint",
  "x-codex-turn-metadata",
  "x-codex-window-id",
] as const;

const TURN_METADATA_KEYS = [
  "agent_name",
  "auto_review_enabled",
  "context_window_id",
  "installation_id",
  "node_repl_auto_review_required",
  "node_repl_disabled",
  "request_kind",
  "sandbox",
  "sandbox_mode",
  "session_id",
  "thread_id",
  "thread_source",
  "turn_id",
  "window_id",
  "window_number",
] as const;

const CTX: RequestContext = {
  provider: "codex",
  model: "gpt-6-astra",
  effort: "medium",
  permissionMode: "default",
  sessionId: "session-fixture",
  cwd: "/workspace/fixture",
  turnId: "turn-fixture",
};

function upgradeHeaders(ctx: RequestContext = CTX): Record<string, string> {
  const requestMetadata = buildCodexRequestMetadata({
    ctx,
    installationId: "installation-fixture",
    mainSessionId: ctx.sessionId,
    mainThreadId: "thread-fixture",
    windowGeneration: 0,
    requestKind: "turn",
  });
  return buildHeaders({
    bearer: "Bearer fixture-token",
    accountId: "account-fixture",
    requestMetadata,
    transport: "ws",
    wsKey: "fixture-websocket-key",
    model: ctx.model,
  });
}

describe("codex responses upgrade fingerprint", () => {
  it("emits exactly the captured upgrade header names", () => {
    const built = Object.keys(upgradeHeaders()).map((name) => name.toLowerCase());
    const onTheWire = [...built, ...UPGRADE_HEADERS_FROM_TRANSPORT.map((n) => n.toLowerCase())];

    expect([...onTheWire].sort()).toEqual([...UPGRADE_HEADERS].sort());
  });

  it("declares the client version and the single managed beta feature", () => {
    const headers = upgradeHeaders();

    expect(headers.version).toBe(CODEX_CLI_VERSION);
    expect(CODEX_CLI_VERSION).toBe("0.153.4");
    expect(headers["x-codex-beta-features"]).toBe("remote_compaction_v2");
    expect(BETA_FEATURES).toBe("remote_compaction_v2");
  });

  it("routes on the wire model", () => {
    expect(upgradeHeaders()["x-codex-routing-hint"]).toBe("model=gpt-6-astra");
    expect(routingHint("gpt-5.5")).toBe("model=gpt-5.5");
  });

  it("keeps the Desktop identity in the originator and user agent", () => {
    const headers = upgradeHeaders();

    expect(headers.originator).toBe(ORIGINATOR_HTTP);
    expect(headers["User-Agent"]).toContain(`${ORIGINATOR_HTTP}/${CODEX_CLI_VERSION}`);
    expect(headers["User-Agent"]).toContain(`(${ORIGINATOR_HTTP}; ${CODEX_APP_VERSION})`);
    expect(CODEX_APP_VERSION).toBe("26.901.41600");
  });

  it("carries hyphenated identity headers and no installation id", () => {
    const headers = upgradeHeaders();

    expect(headers["session-id"]).toBe("session-fixture");
    expect(headers["thread-id"]).toBe("thread-fixture");
    expect(headers.session_id).toBeUndefined();
    expect(headers["x-codex-installation-id"]).toBeUndefined();
  });

  it("pins the turn metadata keys", () => {
    const metadata = JSON.parse(upgradeHeaders()["x-codex-turn-metadata"] as string);
    const keys = Object.keys(metadata).filter((key) => key !== "turn_started_at_unix_ms");

    expect(keys.sort()).toEqual([...TURN_METADATA_KEYS].sort());
    expect(metadata.agent_name).toBe("/root");
    expect(metadata.window_number).toBe(0);
    expect(metadata.installation_id).toBe("installation-fixture");
    expect(metadata.auto_review_enabled).toBe(false);
    expect(metadata.node_repl_auto_review_required).toBe(true);
    expect(metadata.node_repl_disabled).toBe(false);
  });

  it("derives the sandbox mode from the permission mode", () => {
    const modeFor = (permissionMode: RequestContext["permissionMode"]): string =>
      JSON.parse(upgradeHeaders({ ...CTX, permissionMode })["x-codex-turn-metadata"] as string)
        .sandbox_mode;

    expect(modeFor("plan")).toBe("read-only");
    expect(modeFor("default")).toBe("workspace-write");
    expect(modeFor("accept-edits")).toBe("workspace-write");
    expect(modeFor("yolo")).toBe("danger-full-access");
  });

  it("keeps the installation id on the in-frame metadata copy", () => {
    const requestMetadata = buildCodexRequestMetadata({
      ctx: CTX,
      installationId: "installation-fixture",
      mainSessionId: CTX.sessionId,
      mainThreadId: "thread-fixture",
      windowGeneration: 0,
      requestKind: "turn",
    });

    expect(requestMetadata.clientMetadata["x-codex-installation-id"]).toBe("installation-fixture");
    expect(requestMetadata.clientMetadata.session_id).toBe("session-fixture");
    expect(requestMetadata.headerMetadata["x-codex-installation-id"]).toBeUndefined();
  });
});
