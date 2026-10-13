import { describe, expect, test } from "bun:test";
import { createRelayNotice, errorMessage } from "@/design/relay/notice.ts";

describe("relay notice", () => {
  test("writes a repeated failure once until the relay settles", () => {
    const lines: string[] = [];
    const notice = createRelayNotice((line) => lines.push(line));

    notice.report("heartbeat failed: invalid token");
    notice.report("heartbeat failed: invalid token");
    notice.report("heartbeat failed: invalid token");
    expect(lines).toEqual(["design relay: heartbeat failed: invalid token\n"]);

    notice.report("event poll failed: socket closed");
    expect(lines).toHaveLength(2);

    notice.settle();
    notice.report("event poll failed: socket closed");
    expect(lines).toHaveLength(3);
  });

  test("errorMessage keeps Error messages and stringifies the rest", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
    expect(errorMessage("raw")).toBe("raw");
    expect(errorMessage(42)).toBe("42");
  });
});
