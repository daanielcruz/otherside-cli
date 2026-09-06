import { describe, expect, it } from "bun:test";
import { stripAnsi } from "@/terminal-runtime/text/presentation-sequences.js";
import type { Phase } from "@/ui/panels/login/flow.ts";
import { renderLoginFlow } from "@/ui/panels/login/flow-view.ts";

const OAUTH_URL =
  "https://auth.example.com/oauth/authorize?response_type=code&client_id=abc123def456&" +
  "redirect_uri=http%3A%2F%2Flocalhost%3A54321%2Fcallback&scope=openid%20profile%20offline&" +
  "state=9f8e7d6c5b4a3928&code_challenge=Xy1Zab2Cd3Ef4Gh5Ij6Kl7Mn8Op9Qr0St1Uv2Wx&code_challenge_method=S256";
const OSC8_SEQUENCE_RE = /\x1b]8;;[^\x07\x1b]*(?:\x07|\x1b\\)/g;
const OSC8_CLOSE_RE = /^\x1b]8;;(?:\x07|\x1b\\)$/;

function oauthPhase(): Extract<Phase, { kind: "oauth" }> {
  return {
    kind: "oauth",
    provider: { id: "anthropic", label: "Anthropic - OAuth", hint: "", signedIn: false },
    url: OAUTH_URL,
    pasted: "",
    status: "running",
    message: "Browser opened — waiting for redirect…",
    supportsPaste: true,
  };
}

function urlRows(lines: string[]): string[] {
  const first = lines.findIndex((line) => stripAnsi(line).includes("https://"));
  const rows = lines.slice(first);
  return rows.slice(
    0,
    rows.findIndex((line) => stripAnsi(line).trim().length === 0),
  );
}

function labelRows(lines: string[]): string[] {
  const label = lines.findIndex((line) => stripAnsi(line).includes("Browser didn't open?"));
  const rows = lines.slice(label);
  return rows.slice(
    0,
    rows.findIndex((line) => stripAnsi(line).trim().length === 0),
  );
}

function expectLinkedRow(row: string): void {
  const sequences = row.match(OSC8_SEQUENCE_RE) ?? [];
  expect(sequences).toHaveLength(2);
  expect(sequences[0]).toContain(OAUTH_URL);
  expect(sequences[1]).toMatch(OSC8_CLOSE_RE);
}

describe("login OAuth URL", () => {
  it.each([80, 44])("links every wrapped row at %i columns", (width) => {
    const previous = process.env.FORCE_HYPERLINK;
    process.env.FORCE_HYPERLINK = "1";
    try {
      const lines = renderLoginFlow(oauthPhase(), width);
      const label = lines.findIndex((line) => stripAnsi(line).includes("Browser didn't open?"));
      const rows = urlRows(lines);

      expect(stripAnsi(lines[label - 1] ?? "").trim()).toBe("");
      // The label wraps as prose to the panel width; joined back it reads whole.
      expect(labelRows(lines).map(stripAnsi).join(" ").replace(/\s+/g, " ")).toContain(
        "Browser didn't open? Use the url below to sign in (c to copy)",
      );
      expect(rows.length).toBeGreaterThan(1);
      expect(rows.map((row) => stripAnsi(row).trim()).join("")).toBe(OAUTH_URL);
      for (const row of rows) expectLinkedRow(row);
    } finally {
      if (previous === undefined) delete process.env.FORCE_HYPERLINK;
      else process.env.FORCE_HYPERLINK = previous;
    }
  });

  it("keeps the plain fallback copyable", () => {
    const previous = process.env.FORCE_HYPERLINK;
    process.env.FORCE_HYPERLINK = "0";
    try {
      const rows = urlRows(renderLoginFlow(oauthPhase(), 44));

      expect(rows.map((row) => stripAnsi(row).trim()).join("")).toBe(OAUTH_URL);
      expect(rows[0]).toContain("https://");
      expect(rows.join("")).not.toContain("\x1b]8;");
    } finally {
      if (previous === undefined) delete process.env.FORCE_HYPERLINK;
      else process.env.FORCE_HYPERLINK = previous;
    }
  });
});
