import { describe, expect, it } from "bun:test";
import type { UserConfig } from "@/kernel/config/config.ts";
import type { EffortLevel } from "@/kernel/std/types/effort.ts";
import type { BrokerHandle, BrokerState } from "@/kernel/std/types/request.ts";
import type { SessionMetaRecord, SessionRecord } from "../record/index.ts";
import { restoreBrokerStateOnRewind } from "../rewind.ts";
import {
  latestContextUsageSnapshotFromSessionRecords,
  resolveSessionBrokerState,
  type SessionBrokerState,
} from "../state.ts";

const FALLBACK: SessionBrokerState = {
  provider: "anthropic",
  model: "claude-sonnet-5",
  effort: "high",
};

function meta(fields: Partial<SessionMetaRecord>): SessionMetaRecord {
  return {
    type: "session_meta",
    ts: "2026-07-03T00:00:00Z",
    cwd: "/tmp",
    provider: "anthropic",
    model: "claude-sonnet-5",
    ...fields,
  };
}

describe("resolveSessionBrokerState — ultracode restore", () => {
  it("restores ultracode=true recorded by the session", () => {
    const res = resolveSessionBrokerState([meta({ ultracode: true, effort: "xhigh" })], FALLBACK);
    expect(res.ultracode).toBe(true);
  });

  it("restores ultracode=false even when the pre-resume broker had it on (no fallback leak)", () => {
    const res = resolveSessionBrokerState([meta({ ultracode: false, effort: "high" })], {
      ...FALLBACK,
      ultracode: true,
    });
    expect(res.ultracode).toBe(false);
  });

  it("leaves ultracode undefined when no record carries it, so config fallback owns it", () => {
    const res = resolveSessionBrokerState([meta({ effort: "high" })], {
      ...FALLBACK,
      ultracode: true,
    });
    expect(res.ultracode).toBeUndefined();
  });

  it("takes the last recorded ultracode when it changes across metas", () => {
    const res = resolveSessionBrokerState(
      [meta({ ultracode: true, effort: "xhigh" }), meta({ ultracode: false, effort: "high" })],
      FALLBACK,
    );
    expect(res.ultracode).toBe(false);
  });
});

describe("resolveSessionBrokerState — orchestration mode restore", () => {
  it("restores the session's own recorded mode over the fallback", () => {
    const res = resolveSessionBrokerState([meta({ orchestrationMode: "default" })], {
      ...FALLBACK,
      orchestrationMode: "feudalism",
    });
    expect(res.orchestrationMode).toBe("default");
  });

  it("takes the last recorded mode when it changes across metas", () => {
    const res = resolveSessionBrokerState(
      [meta({ orchestrationMode: "feudalism" }), meta({ orchestrationMode: "disabled" })],
      FALLBACK,
    );
    expect(res.orchestrationMode).toBe("disabled");
  });

  it("keeps the fallback mode when no record carries one, and drops invalid values", () => {
    const noRecord = resolveSessionBrokerState([meta({})], {
      ...FALLBACK,
      orchestrationMode: "default",
    });
    expect(noRecord.orchestrationMode).toBe("default");
    const invalid = resolveSessionBrokerState([meta({ orchestrationMode: "bogus" })], {
      ...FALLBACK,
      orchestrationMode: "default",
    });
    expect(invalid.orchestrationMode).toBe("default");
  });
});

describe("resolveSessionBrokerState — route restore", () => {
  function assistantStamp(provider: string, model: string): SessionRecord {
    return {
      type: "assistant_message",
      ts: "2026-07-03T00:00:00Z",
      content: "streamed under the turn's route",
      provider,
      model,
    };
  }

  /**
   * Regression: a route switched mid-turn keeps stamping the OLD route on the
   * in-flight turn's assistant records after the meta that names the new one;
   * resume then restored the old route. The meta snapshots the broker the user
   * chose, so later per-request stamps must not steer the restore.
   */
  it("restores the last meta route over later stamps from an in-flight turn", () => {
    const res = resolveSessionBrokerState(
      [
        meta({ model: "claude-opus-5", effort: "high" }),
        assistantStamp("anthropic", "claude-opus-5"),
        meta({ model: "claude-sonnet-5", effort: "high" }),
        assistantStamp("anthropic", "claude-opus-5"),
        assistantStamp("anthropic", "claude-opus-5"),
      ],
      FALLBACK,
    );
    expect(res.model).toBe("claude-sonnet-5");
    expect(res.effort).toBe("high");
  });

  it("still follows record stamps when the session carries no meta route", () => {
    const res = resolveSessionBrokerState([assistantStamp("anthropic", "claude-opus-5")], FALLBACK);
    expect(res.model).toBe("claude-opus-5");
  });

  it("takes the last meta when the route changes across metas", () => {
    const res = resolveSessionBrokerState(
      [meta({ model: "claude-fable-5" }), meta({ model: "claude-opus-5" })],
      FALLBACK,
    );
    expect(res.model).toBe("claude-opus-5");
  });
});

describe("restoreBrokerStateOnRewind", () => {
  function restore(target: SessionBrokerState): Readonly<BrokerState> {
    let state: BrokerState = {
      provider: "codex",
      model: "test-model",
      effort: "high",
      fastMode: false,
      ultracode: true,
      permissionMode: "default",
      orchestrationMode: "disabled",
    };
    const broker: BrokerHandle = {
      read: () => state,
      dispatch: (event) => {
        if (event.kind === "set_provider") {
          state = {
            ...state,
            provider: event.provider as BrokerState["provider"],
            model: event.model as string,
            effort: "high",
            fastMode: (event.fastMode as boolean | undefined) ?? state.fastMode,
          };
        } else if (event.kind === "set_model") {
          state = { ...state, model: event.model as string, effort: "high" };
        } else if (event.kind === "set_effort") {
          state = { ...state, effort: event.effort as EffortLevel | null, ultracode: false };
        } else if (event.kind === "set_fast_mode") {
          state = { ...state, fastMode: event.enabled as boolean };
        } else if (event.kind === "set_ultracode") {
          state = {
            ...state,
            ultracode: event.enabled as boolean,
            effort: (event.effort as EffortLevel | undefined) ?? "high",
          };
        }
      },
    };
    restoreBrokerStateOnRewind({
      broker,
      target,
      runtimeConfig: { ultracode: true, ultracodeEffort: "high" } as UserConfig,
      suppressRef: { current: false },
      persistedRef: { current: "" },
    });
    return broker.read();
  }

  it("keeps the session-recorded ultracode effort instead of applying the config default", () => {
    const restored = restore({
      provider: "codex",
      model: "test-model",
      effort: "max",
      fastMode: false,
      ultracode: true,
    });

    expect(restored.ultracode).toBe(true);
    expect(restored.effort).toBe("max");
  });

  it("keeps session-recorded ultracode disabled even when config enables it", () => {
    const restored = restore({
      provider: "codex",
      model: "test-model",
      effort: "xhigh",
      fastMode: false,
      ultracode: false,
    });

    expect(restored.ultracode).toBe(false);
    expect(restored.effort).toBe("xhigh");
  });
});

describe("latestContextUsageSnapshotFromSessionRecords with separate usageRecords", () => {
  it("returns usage snapshot when a usage record (estimated: true) in usageRecords is newer than the last assistant_message", () => {
    const records: SessionRecord[] = [
      {
        type: "assistant_message",
        ts: "2026-07-03T00:00:00.000Z",
        content: "hello",
      },
    ];
    const usageRecords: SessionRecord[] = [
      {
        type: "usage",
        ts: "2026-07-03T00:00:01.000Z",
        estimated: true,
        provider: "anthropic",
        model: "claude-3-5-sonnet",
        session_id: "s1",
        request_count: 1,
        input_tokens: 500,
        output_tokens: 100,
        thought_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    ];

    const snapshot = latestContextUsageSnapshotFromSessionRecords(records, undefined, usageRecords);
    expect(snapshot).not.toBeNull();
    expect(snapshot?.inputTokens).toBe(500);
  });

  it("does not return usage record when a compaction_mark in records is newer than the usage record", () => {
    const records: SessionRecord[] = [
      {
        type: "compaction_mark",
        ts: "2026-07-03T00:00:02.000Z",
        summary_ref: "compaction-1",
      },
    ];
    const usageRecords: SessionRecord[] = [
      {
        type: "usage",
        ts: "2026-07-03T00:00:01.000Z",
        estimated: true,
        provider: "anthropic",
        model: "claude-3-5-sonnet",
        session_id: "s1",
        request_count: 1,
        input_tokens: 500,
        output_tokens: 100,
        thought_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    ];

    const snapshot = latestContextUsageSnapshotFromSessionRecords(records, undefined, usageRecords);
    expect(snapshot).toBeNull();
  });
});
