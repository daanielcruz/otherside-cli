import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { LITE_READ_BYTES, readSessionLite } from "@/engine/session/lite.ts";
import { sessionPathForCwd } from "@/engine/session/paths.ts";
import {
  aiTitleLine,
  customTitleLine,
  displayTitleFrom,
  restampSessionTitles,
  seedResumedSessionTitle,
  titlesFromHeadTail,
} from "@/engine/session/title/store.ts";

describe("title resolution over lite windows", () => {
  let base: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "otherside-title-test-"));
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  async function resolveTitle(path: string): Promise<string | undefined> {
    const lite = await readSessionLite({
      path,
      sizeBytes: statSync(path).size,
      buffer: Buffer.alloc(LITE_READ_BYTES),
    });
    if (lite === null) return undefined;
    return displayTitleFrom(titlesFromHeadTail(lite));
  }

  it("finds a title written after a large head record", async () => {
    const path = join(base, "large-head.jsonl");
    const hugeRecord = JSON.stringify({ type: "user", text: "x".repeat(20_000) });
    const filler = Array.from({ length: 40 }, (_, i) =>
      JSON.stringify({ type: "assistant", text: `turn ${i} ${"y".repeat(1_000)}` }),
    );
    writeFileSync(
      path,
      [hugeRecord, aiTitleLine("session-under-test", "found me"), ...filler].join("\n"),
    );
    expect(await resolveTitle(path)).toBe("found me");
  });

  function jsonlWithBuriedTitle(titleLine: string, extraLines: string[] = []): string {
    const hugeRecord = JSON.stringify({ type: "user", text: "x".repeat(70_000) });
    const filler = Array.from({ length: 80 }, (_, i) =>
      JSON.stringify({ type: "assistant", text: `turn ${i} ${"y".repeat(1_000)}` }),
    );
    return [hugeRecord, titleLine, ...extraLines, ...filler].join("\n");
  }

  it("re-stamps a generated title buried beyond both lite windows", async () => {
    const path = join(base, "buried-ai.jsonl");
    writeFileSync(path, jsonlWithBuriedTitle(aiTitleLine("buried-ai", "deep title")));
    expect(await resolveTitle(path)).toBeUndefined();
    await restampSessionTitles(path);
    expect(await resolveTitle(path)).toBe("deep title");
  });

  it("re-stamps a buried user rename, never promoting the generated title", async () => {
    const path = join(base, "buried-custom.jsonl");
    writeFileSync(
      path,
      jsonlWithBuriedTitle(customTitleLine("buried-custom", "my rename"), [
        aiTitleLine("buried-custom", "generated"),
      ]),
    );
    await restampSessionTitles(path);
    expect(await resolveTitle(path)).toBe("my rename");
  });

  it("appends nothing when the lite windows already resolve the true title", async () => {
    const path = join(base, "visible.jsonl");
    writeFileSync(path, [aiTitleLine("visible", "early title"), '{"type":"user"}'].join("\n"));
    const sizeBefore = statSync(path).size;
    await restampSessionTitles(path);
    expect(statSync(path).size).toBe(sizeBefore);
  });
});

describe("seedResumedSessionTitle", () => {
  let base: string;
  let savedConfigDir: string | undefined;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "otherside-title-seed-test-"));
    savedConfigDir = process.env.OTHERSIDE_CONFIG_DIR;
    process.env.OTHERSIDE_CONFIG_DIR = join(base, "config");
  });

  afterEach(() => {
    if (savedConfigDir === undefined) delete process.env.OTHERSIDE_CONFIG_DIR;
    else process.env.OTHERSIDE_CONFIG_DIR = savedConfigDir;
    rmSync(base, { recursive: true, force: true });
  });

  interface SinkRecorder {
    titles: (string | null)[];
    attempts: boolean[];
    setTitle(title: string | null): void;
    setAttempted(attempted: boolean): void;
  }

  function sinkRecorder(): SinkRecorder {
    return {
      titles: [],
      attempts: [],
      setTitle(title) {
        this.titles.push(title);
      },
      setAttempted(attempted) {
        this.attempts.push(attempted);
      },
    };
  }

  function writeSession(id: string, lines: string[]): void {
    const cwd = join(base, "workspace");
    const path = sessionPathForCwd(cwd, id);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, lines.join("\n"));
  }

  async function settled(): Promise<void> {
    for (let tick = 0; tick < 20; tick++) await new Promise((r) => setTimeout(r, 5));
  }

  it("marks generation attempted and loads the persisted title", async () => {
    writeSession("seed-titled", ['{"type":"user"}', aiTitleLine("seed-titled", "kept title")]);
    const sink = sinkRecorder();
    seedResumedSessionTitle(sink, "seed-titled", () => true);
    await settled();
    expect(sink.attempts).toEqual([true]);
    expect(sink.titles).toEqual([null, "kept title"]);
  });

  it("keeps generation closed when no title was persisted", async () => {
    writeSession("seed-untitled", ['{"type":"user"}']);
    const sink = sinkRecorder();
    seedResumedSessionTitle(sink, "seed-untitled", () => true);
    await settled();
    expect(sink.attempts).toEqual([true]);
    expect(sink.titles).toEqual([null]);
  });

  it("drops the loaded title when the session is no longer current", async () => {
    writeSession("seed-stale", ['{"type":"user"}', aiTitleLine("seed-stale", "old title")]);
    const sink = sinkRecorder();
    seedResumedSessionTitle(sink, "seed-stale", () => false);
    await settled();
    expect(sink.titles).toEqual([null]);
  });

  /**
   * Regression: a giant session buries its title lines beyond both bounded
   * lite windows, so the plain read finds nothing and the terminal caption
   * fell back to the product name. The seed must cure through the restamp.
   */
  it("recovers a title buried beyond the lite windows via the restamp", async () => {
    const hugeRecord = JSON.stringify({ type: "user", text: "x".repeat(70_000) });
    const filler = Array.from({ length: 80 }, (_, i) =>
      JSON.stringify({ type: "assistant", text: `turn ${i} ${"y".repeat(1_000)}` }),
    );
    writeSession("seed-buried", [hugeRecord, aiTitleLine("seed-buried", "deep title"), ...filler]);
    const sink = sinkRecorder();
    seedResumedSessionTitle(sink, "seed-buried", () => true);
    await settled();
    expect(sink.attempts).toEqual([true]);
    expect(sink.titles).toEqual([null, "deep title"]);
  });
});
