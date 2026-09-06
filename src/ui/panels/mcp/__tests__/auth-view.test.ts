import { describe, expect, it } from "bun:test";
import { stripAnsi } from "@/terminal-runtime/text/presentation-sequences.js";
import { renderMcpAuth } from "@/ui/panels/mcp/auth-view.ts";

const OAUTH_URL =
  "https://auth.example.com/oauth/authorize?response_type=code&client_id=abc123def456&" +
  "redirect_uri=http%3A%2F%2Flocalhost%3A54321%2Fcallback&scope=openid%20profile%20offline&" +
  "state=9f8e7d6c5b4a3928&code_challenge=Xy1Zab2Cd3Ef4Gh5Ij6Kl7Mn8Op9Qr0St1Uv2Wx&code_challenge_method=S256";
const OSC8_SEQUENCE_RE = /\x1b]8;;[^\x07\x1b]*(?:\x07|\x1b\\)/g;
const OSC8_CLOSE_RE = /^\x1b]8;;(?:\x07|\x1b\\)$/;

function urlRows(lines: string[]): string[] {
  const first = lines.findIndex((line) => stripAnsi(line).includes("https://"));
  const rows = lines.slice(first);
  return rows.slice(
    0,
    rows.findIndex((line) => stripAnsi(line).trim().length === 0),
  );
}

describe("MCP OAuth URL", () => {
  it("links every wrapped fallback row", () => {
    const previous = process.env.FORCE_HYPERLINK;
    process.env.FORCE_HYPERLINK = "1";
    try {
      const rows = urlRows(
        renderMcpAuth(
          {
            serverName: "example",
            url: OAUTH_URL,
            status: "running",
            message: "Browser opened — waiting for authorization…",
            pasted: "",
          },
          44,
        ),
      );

      expect(rows.map((row) => stripAnsi(row).trim()).join("")).toBe(OAUTH_URL);
      for (const row of rows) {
        const sequences = row.match(OSC8_SEQUENCE_RE) ?? [];
        expect(sequences).toHaveLength(2);
        expect(sequences[0]).toContain(OAUTH_URL);
        expect(sequences[1]).toMatch(OSC8_CLOSE_RE);
      }
    } finally {
      if (previous === undefined) delete process.env.FORCE_HYPERLINK;
      else process.env.FORCE_HYPERLINK = previous;
    }
  });
});
