import { describe, expect, it } from "bun:test";
import { isPendingId, isUnsettledUserEcho } from "../stream/static-flush.ts";
import type { TranscriptEntry, TranscriptKind } from "../types";

const base = (kind: TranscriptKind, id: string = kind): TranscriptEntry => ({
  id,
  kind,
  text: kind,
});

describe("transcript row settlement predicates", () => {
  it("treats only t_-prefixed ids as pending", () => {
    expect(isPendingId("t_tool1")).toBe(true);
    expect(isPendingId("u1")).toBe(false);
    expect(isPendingId("a_1_sc0")).toBe(false);
  });

  it("keeps only the trailing user echo unsettled", () => {
    const echo = base("user", "u2");
    const entries = [base("user", "u1"), base("assistant", "a1"), echo];
    const last = entries[entries.length - 1];

    expect(isUnsettledUserEcho(echo, last)).toBe(true);
    expect(isUnsettledUserEcho(entries[0] as TranscriptEntry, last)).toBe(false);
    expect(isUnsettledUserEcho(base("assistant", "a2"), last)).toBe(false);
  });
});
