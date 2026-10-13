import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendRecord } from "@/engine/session/append.ts";
import { sessionPathForCwd } from "@/engine/session/paths.ts";
import { Session } from "@/engine/session/record/state.ts";
import { truncateRewoundTail } from "@/engine/session/rewind.ts";

let base: string;
let savedConfigDir: string | undefined;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "otherside-rewind-truncate-"));
  savedConfigDir = process.env.OTHERSIDE_CONFIG_DIR;
  process.env.OTHERSIDE_CONFIG_DIR = join(base, "config");
});

afterEach(() => {
  if (savedConfigDir === undefined) delete process.env.OTHERSIDE_CONFIG_DIR;
  else process.env.OTHERSIDE_CONFIG_DIR = savedConfigDir;
  rmSync(base, { recursive: true, force: true });
});

function linesOf(session: Session): { uuid?: string; parentUuid?: string | null }[] {
  const text = readFileSync(sessionPathForCwd(session.storageCwd, session.id), "utf8");
  return text
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

describe("truncateRewoundTail", () => {
  it("settles the head before any append queued after a failed truncation", async () => {
    const session = new Session("rewind-failed-truncation", base);
    await appendRecord(session, {
      type: "user_message",
      ts: new Date().toISOString(),
      content: "a",
    });
    const keptHead = session.chain.headUuid;
    session.chain.headUuid = null;

    const truncated = truncateRewoundTail(session, {
      anchorUuid: "not-in-this-file",
      preservedFromByte: 0,
      onFailure: () => {
        session.chain.headUuid = keptHead;
      },
    });
    const appended = appendRecord(session, {
      type: "user_message",
      ts: new Date().toISOString(),
      content: "after the rewind",
    });

    expect(await truncated).toBe(false);
    await appended;
    const last = linesOf(session).at(-1);
    expect(last?.parentUuid).toBe(keptHead);
  });

  it("parents a later append on the turn before the rewound one", async () => {
    const session = new Session("rewind-truncation", base);
    const ts = (): string => new Date().toISOString();
    await appendRecord(session, { type: "user_message", ts: ts(), content: "kept" });
    const keptHead = session.chain.headUuid;
    await appendRecord(session, { type: "user_message", ts: ts(), content: "rewound" });
    const anchorUuid = session.chain.headUuid;
    if (anchorUuid === null) throw new Error("expected a chain head");
    const size = readFileSync(sessionPathForCwd(session.storageCwd, session.id)).length;
    session.chain.headUuid = null;

    const truncated = truncateRewoundTail(session, { anchorUuid, preservedFromByte: size });
    const appended = appendRecord(session, { type: "user_message", ts: ts(), content: "next" });

    expect(await truncated).toBe(true);
    await appended;
    const lines = linesOf(session);
    expect(lines.map((line) => line.uuid)).not.toContain(anchorUuid);
    expect(lines.at(-1)?.parentUuid).toBe(keptHead);
  });
});
