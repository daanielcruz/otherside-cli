import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { sessionPathForCwd } from "@/engine/session/paths.ts";
import { Session } from "@/engine/session/record/index.ts";
import { rewriteSession } from "@/engine/session/rewrite.ts";

const SESSION_ID = "rewrite-guard-session";
const TS = "2026-07-29T00:00:00.000Z";

let base: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "otherside-rewrite-guard-"));
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

/** A session holding one real turn, with the transcript already on disk. */
function sessionWithTranscript(): { session: Session; path: string; original: string } {
  const cwd = join(base, "repo");
  const session = new Session(SESSION_ID, cwd);
  session.pushRecord({
    type: "assistant_message",
    ts: TS,
    uuid: "turn-1",
    content: "the answer the user wants to keep",
  });
  const path = sessionPathForCwd(cwd, SESSION_ID);
  mkdirSync(dirname(path), { recursive: true });
  const original = `{"type":"assistant","uuid":"turn-1","body":"on disk"}\n`;
  writeFileSync(path, original);
  return { session, path, original };
}

describe("rewriting a transcript from session records", () => {
  it("rebuilds the file when the records are the whole conversation", async () => {
    const { session, path, original } = sessionWithTranscript();

    await rewriteSession(session);

    expect(readFileSync(path, "utf8")).not.toBe(original);
    expect(readFileSync(path, "utf8")).toContain("the answer the user wants to keep");
  });

  it("refuses when the records are a reduced view of a large resume", async () => {
    const { session, path, original } = sessionWithTranscript();
    // The large resume path hands back bodyless stubs for history it never read.
    // Writing those back would replace real turns with the summaries standing in
    // for them, so the file is left exactly as it was found.
    session.recordsArePartial = true;

    await rewriteSession(session);

    expect(readFileSync(path, "utf8")).toBe(original);
  });
});
