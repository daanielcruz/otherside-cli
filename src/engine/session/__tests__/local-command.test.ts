import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { persistLocalCommand } from "../local-command.ts";
import { Session } from "../record/index.ts";

let base: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "local-command-"));
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe("persistLocalCommand", () => {
  it("records the three-block shape for a direct-set effort command", async () => {
    const session = new Session("session-lc", base);
    await persistLocalCommand({
      session,
      commandName: "effort",
      args: "high",
      stdout: "Set effort level to high",
      provider: "anthropic",
      model: "claude-sonnet-5",
      permissionMode: "default",
    });

    expect(session.messages.length).toBe(3);
    const texts = session.messages.map((m) => {
      const block = m.content[0];
      return block?.type === "text" ? block.text : "";
    });
    expect(texts[0]).toStartWith("<local-command-caveat>");
    expect(texts[0]).toEndWith("</local-command-caveat>");
    expect(texts[1]).toContain("<command-name>/effort</command-name>");
    expect(texts[1]).toContain("<command-args>high</command-args>");
    expect(texts[2]).toBe("<local-command-stdout>Set effort level to high</local-command-stdout>");

    const userRecords = session.records.filter((r) => r.type === "user_message");
    expect(userRecords.length).toBe(3);
    const stdoutRecord = userRecords[2];
    if (stdoutRecord?.type !== "user_message") throw new Error("expected user_message record");
    expect(stdoutRecord.content).toContain("<local-command-stdout>");
  });
});
