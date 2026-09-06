import { afterEach, describe, expect, it } from "bun:test";
import { recordsFromParsedLine } from "@/engine/session/record/reader.ts";
import type { SessionMetaRecord } from "@/engine/session/record/schema.ts";
import { serializeRecord } from "@/engine/session/record/serializers.ts";
import { SessionChain } from "@/engine/session/record/state.ts";
import {
  registerSessionMetaRemoteEnabled,
  sessionMetaFromBrokerState,
} from "@/engine/session/state.ts";

const BROKER_STATE: Parameters<typeof sessionMetaFromBrokerState>[1] = {
  provider: "anthropic",
  model: "claude-fable-5",
  effort: null,
  fastMode: false,
  ultracode: false,
  orchestrationMode: "default",
};

const SESSION = { cwd: "/tmp/project", storageCwd: "/tmp/project" };

afterEach(() => {
  registerSessionMetaRemoteEnabled(null);
});

describe("session meta remote activation", () => {
  it("freezes the registered activation on every built meta record", () => {
    registerSessionMetaRemoteEnabled(() => true);
    const meta = sessionMetaFromBrokerState(SESSION, BROKER_STATE, "2026-07-18T00:00:00.000Z");
    expect(meta.remoteEnabled).toBe(true);
  });

  it("omits the field when no activation source is registered", () => {
    const meta = sessionMetaFromBrokerState(SESSION, BROKER_STATE, "2026-07-18T00:00:00.000Z");
    expect("remoteEnabled" in meta).toBe(false);
  });

  it("survives serialize -> parse", () => {
    registerSessionMetaRemoteEnabled(() => false);
    const meta = sessionMetaFromBrokerState(SESSION, BROKER_STATE, "2026-07-18T00:00:00.000Z");
    const line = serializeRecord(meta, new SessionChain(), {
      sessionId: "s1",
      cwd: "/tmp/project",
    });
    const parsed = recordsFromParsedLine(JSON.parse(line) as Record<string, unknown>);
    const restored = parsed.find((r): r is SessionMetaRecord => r.type === "session_meta");
    expect(restored?.remoteEnabled).toBe(false);
  });

  it("stays absent on the wire when the record has no value", () => {
    const meta = sessionMetaFromBrokerState(SESSION, BROKER_STATE, "2026-07-18T00:00:00.000Z");
    const line = serializeRecord(meta, new SessionChain(), {
      sessionId: "s1",
      cwd: "/tmp/project",
    });
    expect(line.includes("remoteEnabled")).toBe(false);
    const parsed = recordsFromParsedLine(JSON.parse(line) as Record<string, unknown>);
    const restored = parsed.find((r): r is SessionMetaRecord => r.type === "session_meta");
    expect(restored?.remoteEnabled).toBeUndefined();
  });
});
