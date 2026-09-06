import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SlashCommand } from "@/commands/catalog.ts";
import type { SlashContext } from "@/commands/types.ts";
import type { Session as SessionState } from "@/engine/session/record/state.ts";
import type { PendingGroup } from "@/kernel/channels/ask.ts";

assert.equal(process.platform, "win32", "This gate requires Windows");
const fixture = mkdtempSync(join(tmpdir(), "windows-short-path-gate-"));

try {
  const home = join(fixture, "home");
  mkdirSync(home);
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.OTHERSIDE_CONFIG_DIR = join(home, "config");
  process.env.OTHERSIDE_EPHEMERAL_SESSIONS_DIR = join(home, "sessions");
  process.env.OTHERSIDE_POLICY_DIR = join(home, "policy");
  await verifyPaths();
} finally {
  rmSync(fixture, { recursive: true, force: true });
}

async function verifyPaths(): Promise<void> {
  const { canonicalizeCwd } = await import("@/kernel/std/fs/paths.ts");
  const { isPathTrusted, setPathTrusted } = await import("@/kernel/config/project-trust.ts");
  const { handleCd } = await import("@/commands/handlers/cd.ts");
  const { Session } = await import("@/engine/session/record/state.ts");
  const ask = await import("@/kernel/channels/ask.ts");
  const { getTrackedCwd, setTrackedCwd } = await import("@/kernel/std/state/cwd-state.ts");
  const originalTrackedCwd = getTrackedCwd();
  const command: SlashCommand = {
    name: "cd",
    kind: "instant",
    description: "Move fixture",
    argumentHint: "<path>",
  };
  const shortPathScript = join(fixture, "short-path.vbs");
  writeFileSync(
    shortPathScript,
    'WScript.Echo CreateObject("Scripting.FileSystemObject").GetFolder(WScript.Arguments(0)).ShortPath\r\n',
  );

  async function directoryPair(label: string): Promise<{ shortPath: string; longPath: string }> {
    const directory = join(fixture, `long directory ${label}`);
    mkdirSync(directory);
    const longPath = await realpath(directory);
    const shortPath = execFileSync("cscript.exe", ["//nologo", shortPathScript, longPath], {
      encoding: "utf8",
      timeout: 10_000,
    }).trim();
    assert.notEqual(shortPath.toLowerCase(), longPath.toLowerCase(), "No distinct 8.3 alias");
    assert.match(shortPath, /(?:^|[\\/])[^\\/]*~\d+(?:[\\/]|$)/, "No abbreviated 8.3 component");
    const marker = `identity-${crypto.randomUUID()}`;
    writeFileSync(join(longPath, "identity.txt"), marker);
    assert.equal(readFileSync(join(shortPath, "identity.txt"), "utf8"), marker);
    writeFileSync(join(shortPath, "identity.txt"), `${marker}-short`);
    assert.equal(readFileSync(join(longPath, "identity.txt"), "utf8"), `${marker}-short`);
    const native = realpathSync.native(shortPath);
    const asynchronous = await realpath(shortPath);
    assert.equal(native, longPath);
    assert.equal(asynchronous, longPath);
    assert.equal(canonicalizeCwd(shortPath), longPath);
    assert.equal(canonicalizeCwd(longPath), longPath);
    console.log(
      JSON.stringify({
        check: "real-alias",
        label,
        shortPath,
        longPath,
        sync: realpathSync(shortPath),
        native,
        asynchronous,
      }),
    );
    return { shortPath, longPath };
  }

  function observeRefusals(questions: string[]): () => void {
    return ask.subscribe((groups: PendingGroup[]) => {
      for (const group of groups) {
        questions.push(...group.questions.map((question) => question.question));
        ask.resolveGroup(group.id, { declined: true, reason: "cancel" });
      }
    });
  }

  async function runWithoutQuestion(session: SessionState, destination: string) {
    const unexpected: string[] = [];
    const unsubscribe = observeRefusals(unexpected);
    const move = handleCd(command, destination, makeContext(session));
    try {
      const result = await move;
      assert.deepEqual(unexpected, [], "A physically trusted path requested trust again");
      return result;
    } finally {
      ask.clear();
      unsubscribe();
      await move;
    }
  }

  try {
    const fromShort = await directoryPair("trusted by short name");
    const fromLong = await directoryPair("trusted by long name");
    const sibling = await directoryPair("untrusted sibling");
    await setPathTrusted(fromShort.shortPath);
    assert.equal(isPathTrusted(fromShort.longPath), true);
    await setPathTrusted(fromLong.longPath);
    assert.equal(isPathTrusted(fromLong.shortPath), true);
    assert.equal(isPathTrusted(sibling.longPath), false);
    assert.equal(isPathTrusted(sibling.shortPath), false);

    const session = new Session("short-path-gate", fromShort.shortPath);
    setTrackedCwd(fromShort.shortPath);
    const noMove = await runWithoutQuestion(session, ".");
    assert.equal(noMove.feedback, `Already in ${fromShort.longPath}.`);
    assert.equal(session.cwd, fromShort.shortPath);
    const child = join(fromShort.longPath, "child with spaces");
    mkdirSync(child);
    const moved = await runWithoutQuestion(session, "child with spaces");
    assert.equal(moved.feedback, `Moved to ${await realpath(child)}`);
    assert.equal(session.cwd, await realpath(child));

    const questions: string[] = [];
    const unsubscribe = observeRefusals(questions);
    const refused = handleCd(command, sibling.shortPath, makeContext(session));
    try {
      const result = await refused;
      assert.equal(questions.length, 1, "Untrusted sibling must request trust exactly once");
      const question = questions[0];
      assert.ok(question);
      assert.match(question, /Moving to a new directory/);
      assert.equal(result.feedback, `Staying in ${await realpath(child)}`);
      assert.equal(session.cwd, await realpath(child));
      assert.equal(isPathTrusted(sibling.shortPath), false);
    } finally {
      ask.clear();
      unsubscribe();
      await refused;
    }
    console.log(
      "PASS: 3 real 8.3 aliases; cross-path IO, native/async identity, bidirectional trust, relative move, no-op and untrusted sibling verified",
    );
  } finally {
    ask.clear();
    setTrackedCwd(originalTrackedCwd);
  }
}

function makeContext(session: SessionState): SlashContext {
  return {
    session,
    broker: {
      read: () => ({
        provider: "anthropic",
        model: "fixture",
        effort: null,
        fastMode: false,
        permissionMode: "default",
        ultracode: false,
      }),
    },
    agent: { pushInjection: () => {} },
    exit: () => {},
    clearTranscript: () => {},
    openOverlay: () => {},
  } as unknown as SlashContext;
}
