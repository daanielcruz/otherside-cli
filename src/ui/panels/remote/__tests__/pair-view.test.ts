import { describe, expect, test } from "bun:test";
import type { PairHandle } from "@/backend/index.ts";
import { stripAnsi } from "@/terminal-runtime/text/presentation-sequences.ts";
import { remoteMainActions } from "@/ui/panels/remote/data.ts";
import { pairBodyLines } from "@/ui/panels/remote/pair-view.ts";

function pairHandle(): PairHandle {
  return {
    qr: "QR PLACEHOLDER",
    nonceB64: "nonce-placeholder",
    payload: "OS3:PAYLOAD",
    userCode: "ABCD-2345",
    expiresInSeconds: 900,
    awaiting: new Promise(() => {}),
    cancel() {},
  };
}

describe("remote device-approved pairing view", () => {
  test("offers pairing before optional login while signed out", () => {
    expect(remoteMainActions(false, false)).toEqual(["pair", "login"]);
  });

  test("shows the approval code and backend TTL", () => {
    const text = pairBodyLines(
      {
        phase: "awaiting",
        result: null,
        error: null,
        handle: pairHandle(),
      },
      40,
    )
      .map(stripAnsi)
      .join("\n");

    expect(text).toContain("ABCD-2345");
    expect(text).toContain("Awaiting approval");
    expect(text).toContain("Code expires after 15 min");
  });

  test("renders consumed-code failures without treating them as expiry", () => {
    const text = pairBodyLines(
      {
        phase: "failed",
        result: null,
        error: "pairing code was already used — generate a new code",
        handle: null,
      },
      40,
    )
      .map(stripAnsi)
      .join("\n");

    expect(text).toContain("Pairing failed");
    expect(text).toContain("already used");
  });
});
