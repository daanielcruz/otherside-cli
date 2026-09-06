import { describe, expect, it } from "bun:test";
import { createSessionControlModeReader } from "@/terminal-runtime/host/session-control-mode.ts";

function reader(environment: NodeJS.ProcessEnv, queryClient = () => false): () => boolean {
  return createSessionControlModeReader({ environment: () => environment, queryClient });
}

describe("session control mode", () => {
  it("stays disabled outside tmux without querying a client", () => {
    let queries = 0;
    const detect = reader({}, () => {
      queries++;
      return true;
    });

    expect(detect()).toBe(false);
    expect(queries).toBe(0);
  });

  it("recognizes the iTerm integration environment", () => {
    expect(reader({ TMUX: "1", TERM_PROGRAM: "iTerm.app", TERM: "xterm-256color" })()).toBe(true);
    expect(reader({ TMUX: "1", TERM_PROGRAM: "iTerm.app", TERM: "tmux-256color" })()).toBe(false);
  });

  it("queries tmux only when the host program is absent", () => {
    let queries = 0;
    const detect = reader({ TMUX: "1" }, () => {
      queries++;
      return true;
    });

    expect(detect()).toBe(true);
    expect(queries).toBe(1);
    expect(reader({ TMUX: "1", TERM_PROGRAM: "vscode" }, () => true)()).toBe(false);
  });

  it("caches both positive and negative probe results", () => {
    let positiveQueries = 0;
    const positive = reader({ TMUX: "1" }, () => {
      positiveQueries++;
      return true;
    });
    expect(positive()).toBe(true);
    expect(positive()).toBe(true);
    expect(positiveQueries).toBe(1);

    let negativeQueries = 0;
    const negative = reader({ TMUX: "1" }, () => {
      negativeQueries++;
      return false;
    });
    expect(negative()).toBe(false);
    expect(negative()).toBe(false);
    expect(negativeQueries).toBe(1);
  });
});
