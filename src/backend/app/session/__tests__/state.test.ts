import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionRecord } from "@/kernel/std/types/session.ts";
import {
  initRemoteSession,
  isRemoteEnabled,
  removeLegacyRemoteSessionState,
  resolveRecordedRemoteEnabled,
  setAutoEnable,
  setRemoteEnabled,
  sweepLegacyRemoteSessionState,
} from "../state.ts";

let home: string;
let savedRemoteHome: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "otherside-remote-state-test-"));
  savedRemoteHome = process.env.OTHERSIDE_REMOTE_HOME;
  process.env.OTHERSIDE_REMOTE_HOME = home;
});

afterEach(() => {
  if (savedRemoteHome === undefined) {
    delete process.env.OTHERSIDE_REMOTE_HOME;
  } else {
    process.env.OTHERSIDE_REMOTE_HOME = savedRemoteHome;
  }
  rmSync(home, { recursive: true, force: true });
});

function meta(remoteEnabled?: boolean): SessionRecord {
  return remoteEnabled === undefined
    ? { type: "session_meta" }
    : { type: "session_meta", remoteEnabled };
}

function legacyFile(sessionId: string, enabled: boolean): string {
  const path = join(home, `session-${sessionId}.json`);
  writeFileSync(path, JSON.stringify({ version: 2, enabled }));
  return path;
}

describe("remote session activation", () => {
  it("restores the latest recorded activation from session metadata", () => {
    expect(
      initRemoteSession("session-a", [meta(true), { type: "user_message" }, meta(false)]),
    ).toBe("records");
    expect(isRemoteEnabled()).toBe(false);

    expect(initRemoteSession("session-a", [meta(false), meta(true)])).toBe("records");
    expect(isRemoteEnabled()).toBe(true);

    expect(initRemoteSession("session-a", [meta(true), meta()])).toBe("records");
    expect(isRemoteEnabled()).toBe(true);
  });

  it("adopts a legacy activation file only when metadata carries no value", () => {
    legacyFile("session-legacy", true);

    expect(initRemoteSession("session-legacy", [])).toBe("legacy");
    expect(isRemoteEnabled()).toBe(true);

    expect(initRemoteSession("session-legacy", [meta(false)])).toBe("records");
    expect(isRemoteEnabled()).toBe(false);
  });

  it("ignores activation files written before session isolation", () => {
    writeFileSync(join(home, "session-old.json"), JSON.stringify({ enabled: true }));

    expect(initRemoteSession("session-old", [])).toBe("default");
    expect(isRemoteEnabled()).toBe(false);
  });

  it("applies the auto-enable default only without recorded or legacy state", () => {
    setAutoEnable(true);
    expect(initRemoteSession("fresh-session", [])).toBe("default");
    expect(isRemoteEnabled()).toBe(true);

    setAutoEnable(false);
    expect(initRemoteSession("fresh-session", [])).toBe("default");
    expect(isRemoteEnabled()).toBe(false);

    expect(initRemoteSession("recorded-session", [meta(true)])).toBe("records");
    expect(isRemoteEnabled()).toBe(true);
  });

  it("toggling never writes per-session files", () => {
    initRemoteSession("session-a", []);
    setRemoteEnabled(true);
    setRemoteEnabled(false);
    expect(existsSync(join(home, "session-session-a.json"))).toBe(false);
  });
});

describe("resolveRecordedRemoteEnabled", () => {
  it("returns null when no metadata carries the flag", () => {
    expect(resolveRecordedRemoteEnabled([])).toBeNull();
    expect(resolveRecordedRemoteEnabled([meta(), { type: "user_message" }])).toBeNull();
  });
});

describe("legacy activation-file cleanup", () => {
  it("removes a single session's file", () => {
    const path = legacyFile("session-a", true);
    removeLegacyRemoteSessionState("session-a");
    expect(existsSync(path)).toBe(false);
  });

  it("sweeps only files whose session transcript is gone", () => {
    const live = legacyFile("session-live", true);
    const dead = legacyFile("session-dead", false);
    writeFileSync(join(home, "state.json"), JSON.stringify({ autoEnable: false }));

    sweepLegacyRemoteSessionState(new Set(["session-live"]));

    expect(existsSync(live)).toBe(true);
    expect(existsSync(dead)).toBe(false);
    expect(existsSync(join(home, "state.json"))).toBe(true);
  });
});
