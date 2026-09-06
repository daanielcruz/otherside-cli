import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultEffortForModel,
  defaultModelForProvider,
  effortLevelsForModel,
  findModel,
} from "@/engine/model/catalog.ts";
import { Agent } from "@/engine/queue/index.ts";
import { Session } from "@/engine/session/record/index.ts";
import { sessionMetaFromBrokerState } from "@/engine/session/state.ts";
import { DEFAULT_CONFIG } from "@/kernel/config/config.ts";
import { Broker } from "@/store/app-store/broker.ts";
import { createPasteStore } from "@/store/paste-store/index.ts";
import { createQueueHelpers } from "@/ui/app/drain/queue.ts";

let base: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "queue-helpers-"));
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
  // The fixture broker claims the process registration on construction; leaving it
  // claimed would answer for a route later files never set.
  for (const broker of brokers.splice(0)) broker.release();
});

const brokers: Broker[] = [];

function setup() {
  const broker = registerFixtureBroker(
    new Broker(
      {
        provider: "anthropic",
        model: "claude-sonnet-5",
        effort: "high",
        fastMode: false,
        permissionMode: "default",
        orchestrationMode: "disabled",
      },
      { findModel, effortLevelsForModel, defaultEffortForModel, defaultModelForProvider },
    ),
  );
  const session = new Session("session-qh", base);
  const agent = new Agent({
    broker,
    session,
    config: DEFAULT_CONFIG,
    getLastUsage: () => null,
  });
  const helpers = createQueueHelpers({
    pasteStoreRef: { current: createPasteStore("session-qh") },
    session,
    agent,
    broker,
    compactTerminalRef: { current: false },
    runtimeConfigRef: { current: DEFAULT_CONFIG },
  });
  return { broker, session, helpers };
}

describe("applyPendingChange", () => {
  it("effort change lands on broker state immediately (next request reads it)", () => {
    const { broker, helpers } = setup();
    helpers.applyPendingChange({ kind: "set_effort", effort: "medium" });
    expect(broker.read().effort).toBe("medium");
  });

  it("refreshes the un-flushed boot meta so the first prompt records the new state", () => {
    const { broker, session, helpers } = setup();
    session.pendingMeta = sessionMetaFromBrokerState(
      session,
      broker.read(),
      "2026-07-02T00:00:00Z",
    );
    helpers.applyPendingChange({ kind: "set_effort", effort: "low" });
    expect(session.pendingMeta).not.toBeNull();
    if (session.pendingMeta?.type !== "session_meta") throw new Error("expected meta");
    expect(session.pendingMeta.effort).toBe("low");
  });

  it("leaves pendingMeta null once already flushed", () => {
    const { session, helpers } = setup();
    session.pendingMeta = null;
    helpers.applyPendingChange({ kind: "set_effort", effort: "low" });
    expect(session.pendingMeta).toBeNull();
  });
});

function registerFixtureBroker(broker: Broker): Broker {
  brokers.push(broker);
  return broker;
}
