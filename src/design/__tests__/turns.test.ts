import { describe, expect, test } from "bun:test";
import {
  cancelDesignTurn,
  drainDesignSteerMessages,
  drainDesignSteers,
  isDesignTurnActive,
  ownsDesignTurn,
  registerDesignTurn,
  setDesignTurnSteerable,
  steerDesignTurn,
  unregisterDesignTurn,
} from "@/design/turns.ts";

let counter = 0;
function designId(): string {
  counter += 1;
  return `design-turns-test-${counter}`;
}

describe("design turn registry", () => {
  test("a steer is accepted only while the design fork can drain it", () => {
    const id = designId();
    const controller = new AbortController();
    registerDesignTurn(id, controller);

    expect(steerDesignTurn(id, "tighten the header")).toBe(true);
    expect(drainDesignSteers(id)).toEqual(["tighten the header"]);

    setDesignTurnSteerable(id, controller, false);
    expect(steerDesignTurn(id, "lost otherwise")).toBe(false);
    expect(drainDesignSteers(id)).toEqual([]);
    expect(isDesignTurnActive(id)).toBe(true);

    setDesignTurnSteerable(id, controller, true);
    expect(steerDesignTurn(id, "repair round steer")).toBe(true);
    expect(drainDesignSteerMessages(id)).toEqual([
      { text: "repair round steer", blocks: [{ type: "text", text: "repair round steer" }] },
    ]);
    unregisterDesignTurn(id, controller);
  });

  test("closing the steer window drops steers nobody will drain", () => {
    const id = designId();
    const controller = new AbortController();
    registerDesignTurn(id, controller);
    steerDesignTurn(id, "queued during the fork");

    setDesignTurnSteerable(id, controller, false);
    expect(drainDesignSteers(id)).toEqual([]);
    unregisterDesignTurn(id, controller);
  });

  test("a superseding turn aborts the previous one and takes ownership", () => {
    const id = designId();
    const first = new AbortController();
    const second = new AbortController();
    registerDesignTurn(id, first);
    setDesignTurnSteerable(id, first, false);

    expect(steerDesignTurn(id, "arrives during verification")).toBe(false);
    registerDesignTurn(id, second);

    expect(first.signal.aborted).toBe(true);
    expect(first.signal.reason).toBe("superseded");
    expect(ownsDesignTurn(id, first)).toBe(false);
    expect(ownsDesignTurn(id, second)).toBe(true);

    // The superseded handler's teardown must leave the live turn untouched.
    setDesignTurnSteerable(id, first, false);
    unregisterDesignTurn(id, first);
    expect(isDesignTurnActive(id)).toBe(true);
    expect(steerDesignTurn(id, "for the new fork")).toBe(true);
    expect(drainDesignSteers(id)).toEqual(["for the new fork"]);
    unregisterDesignTurn(id, second);
    expect(isDesignTurnActive(id)).toBe(false);
  });

  test("cancel aborts the turn but leaves teardown to its owner", () => {
    const id = designId();
    const controller = new AbortController();
    registerDesignTurn(id, controller);
    steerDesignTurn(id, "pending");

    expect(cancelDesignTurn(id)).toBe(true);
    expect(controller.signal.reason).toBe("cancelled");
    expect(steerDesignTurn(id, "after cancel")).toBe(false);
    expect(drainDesignSteers(id)).toEqual([]);
    expect(ownsDesignTurn(id, controller)).toBe(true);

    unregisterDesignTurn(id, controller);
    expect(isDesignTurnActive(id)).toBe(false);
    expect(cancelDesignTurn(id)).toBe(false);
  });
});
