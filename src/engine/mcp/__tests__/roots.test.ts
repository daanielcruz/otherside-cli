import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOTS_METHOD, serveRoots, sessionRoots } from "@/engine/mcp/roots.ts";
import { answerInbound, clearInboundResponders } from "@/kernel/mcp/protocol/inbound.ts";

// Owned by this file: the suite shares one process, so the config dir another
// file set is that file's to restore.
let base: string;
let cwd: string;
let priorConfigDir: string | undefined;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "otherside-roots-"));
  cwd = join(base, "workspace");
  mkdirSync(cwd, { recursive: true });
  priorConfigDir = process.env.OTHERSIDE_CONFIG_DIR;
  process.env.OTHERSIDE_CONFIG_DIR = join(base, "config");
  mkdirSync(join(base, "config"), { recursive: true });
});

afterEach(() => {
  clearInboundResponders();
  if (priorConfigDir === undefined) delete process.env.OTHERSIDE_CONFIG_DIR;
  else process.env.OTHERSIDE_CONFIG_DIR = priorConfigDir;
  rmSync(base, { recursive: true, force: true });
});

function grantDirectories(directories: string[]): void {
  writeFileSync(
    join(base, "config", "settings.json"),
    JSON.stringify({ permissions: { additionalDirectories: directories } }),
    "utf8",
  );
}

describe("the directories a server is told about", () => {
  test("start with the working directory, as a file url with a readable name", async () => {
    const roots = await sessionRoots(cwd);
    expect(roots).toHaveLength(1);
    expect(roots[0]?.uri.startsWith("file://")).toBe(true);
    expect(roots[0]?.uri).toContain("workspace");
    expect(roots[0]?.name).toBe("workspace");
  });

  test("include what the reader granted beyond it, in that order", async () => {
    const extra = join(base, "shared");
    mkdirSync(extra, { recursive: true });
    grantDirectories([extra]);

    const roots = await sessionRoots(cwd);
    expect(roots.map((root) => root.name)).toEqual(["workspace", "shared"]);
  });

  test("name a directory once even when it was granted twice", async () => {
    grantDirectories([cwd, cwd]);
    expect(await sessionRoots(cwd)).toHaveLength(1);
  });
});

describe("answering the server's question", () => {
  test("serves roots/list once mounted, and stops when torn down", async () => {
    const stop = serveRoots(() => cwd);
    const answer = await answerInbound({
      server: "probe",
      method: ROOTS_METHOD,
      params: {},
      signal: new AbortController().signal,
    });
    expect(answer.result).toMatchObject({ roots: [{ name: "workspace" }] });

    stop();
    const afterStop = await answerInbound({
      server: "probe",
      method: ROOTS_METHOD,
      params: {},
      signal: new AbortController().signal,
    });
    expect(afterStop.error).toBeDefined();
  });
});
