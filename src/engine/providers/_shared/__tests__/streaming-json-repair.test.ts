import { describe, expect, it } from "bun:test";
import { parseJsonWithPartialRecovery } from "@/engine/providers/_shared/streaming-json-repair.ts";

describe("parseJsonWithPartialRecovery", () => {
  it("preserves complete JSON values", () => {
    expect(parseJsonWithPartialRecovery('{"value":null,"nested":{"items":[1,true,"ok"]}}')).toEqual(
      {
        ok: true,
        value: { value: null, nested: { items: [1, true, "ok"] } },
      },
    );
  });

  it("recovers a missing final object closer", () => {
    expect(parseJsonWithPartialRecovery('{"command":"printf ok"')).toEqual({
      ok: true,
      value: { command: "printf ok" },
    });
  });

  it("adds nested object and array closers in reverse order", () => {
    expect(parseJsonWithPartialRecovery('{"outer":[{"command":"printf ok"')).toEqual({
      ok: true,
      value: { outer: [{ command: "printf ok" }] },
    });
  });

  it("trims trailing commas and incomplete final key-value tokens", () => {
    expect(parseJsonWithPartialRecovery('{"command":"printf ok",')).toEqual({
      ok: true,
      value: { command: "printf ok" },
    });
    expect(parseJsonWithPartialRecovery('{"command":"printf ok","next":')).toEqual({
      ok: true,
      value: { command: "printf ok" },
    });
  });

  it("preserves escaped quote, backslash, and unicode sequences", () => {
    expect(
      parseJsonWithPartialRecovery('{"value":"quote: \\"; slash: \\\\; snowman: \\u2603"'),
    ).toEqual({
      ok: true,
      value: { value: 'quote: "; slash: \\; snowman: ☃' },
    });
  });

  it("returns false for irrecoverable non-JSON", () => {
    expect(parseJsonWithPartialRecovery("not json")).toEqual({ ok: false });
  });
});
