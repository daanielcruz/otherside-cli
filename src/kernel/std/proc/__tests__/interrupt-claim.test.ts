import { describe, expect, it } from "bun:test";
import {
  claimInterrupt,
  deliverClaimedInterrupt,
  interruptIsClaimed,
} from "@/kernel/std/proc/interrupt-claim.ts";

describe("interrupt claim", () => {
  it("lets the caller exit when nobody owns the interrupt", () => {
    expect(interruptIsClaimed()).toBe(false);
    expect(deliverClaimedInterrupt()).toBe(false);
  });

  it("hands a claimed interrupt to its owner instead of exiting", () => {
    let pressed = 0;
    const release = claimInterrupt(() => {
      pressed += 1;
    });
    expect(interruptIsClaimed()).toBe(true);
    expect(deliverClaimedInterrupt()).toBe(true);
    expect(deliverClaimedInterrupt()).toBe(true);
    expect(pressed).toBe(2);
    release();
    expect(interruptIsClaimed()).toBe(false);
  });

  it("ignores a stale release after a newer owner took over", () => {
    const releaseOld = claimInterrupt(() => {});
    let newest = 0;
    const releaseNew = claimInterrupt(() => {
      newest += 1;
    });
    releaseOld();
    expect(deliverClaimedInterrupt()).toBe(true);
    expect(newest).toBe(1);
    releaseNew();
  });
});
