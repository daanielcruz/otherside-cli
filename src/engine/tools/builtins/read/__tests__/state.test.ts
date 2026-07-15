import { afterEach, describe, expect, it } from "bun:test";
import { clearReadStateForScope, readSetContains, readSetInsert } from "../state.ts";

const scope = "read-state-test";

describe("READ_STATE", () => {
  afterEach(() => {
    clearReadStateForScope(scope);
  });

  it("evicts oldest entries when cached content exceeds the upstream-sized byte cap", () => {
    const oneMiB = "x".repeat(1024 * 1024);

    for (let i = 0; i < 26; i += 1) {
      readSetInsert(scope, `missing-${i}.txt`, oneMiB);
    }

    expect(readSetContains(scope, "missing-0.txt")).toBe(false);
    expect(readSetContains(scope, "missing-25.txt")).toBe(true);
  });
});
