import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  askGroup,
  clear as clearAskQueue,
  type GroupQuestion,
  type GroupResult,
  pending,
} from "@/kernel/channels/ask.ts";
import type { Session } from "@/kernel/std/types/session.ts";
import type { Broker } from "@/store/app-store/broker.ts";
import { applyAskResponse } from "../ask-response.ts";
import { applyIncomingEvent, isSyncableEvent } from "../rails/durable.ts";

beforeEach(() => {
  // Shared duplex channel; clear before each case so earlier suites cannot pollute.
  clearAskQueue();
});

afterEach(() => {
  // Resolve any groups a failing test left behind so promises do not leak.
  clearAskQueue();
});

function question(text: string, opts: Partial<GroupQuestion> = {}): GroupQuestion {
  return {
    question: text,
    options: [
      { label: "Red", description: "" },
      { label: "Blue", description: "" },
    ],
    multiSelect: false,
    ...opts,
  };
}

// askGroup resolves synchronously when answered; a settled marker lets tests
// assert both resolution and continued pendingness without hanging.
function track(promise: Promise<GroupResult>): {
  settled: () => boolean;
  value: () => GroupResult;
} {
  let done = false;
  let result: GroupResult | undefined;
  promise.then((r) => {
    done = true;
    result = r;
  });
  return {
    settled: () => done,
    value: () => {
      if (result === undefined) throw new Error("group not resolved");
      return result;
    },
  };
}

describe("applyAskResponse", () => {
  it("resolves a single-select answer with the chosen label", async () => {
    const tracked = track(askGroup([question("Pick a color")]));

    const handled = applyAskResponse({
      call_id: "call-1",
      answers: [{ question: "Pick a color", labels: ["Blue"] }],
    });
    await Bun.sleep(0);

    expect(handled).toBe(true);
    expect(tracked.settled()).toBe(true);
    expect(tracked.value()).toEqual({
      declined: false,
      answers: [{ question: "Pick a color", answer: "Blue" }],
    });
    expect(pending()).toHaveLength(0);
  });

  it("joins multiSelect labels with a comma, like the terminal overlay", async () => {
    const tracked = track(askGroup([question("Pick colors", { multiSelect: true })]));

    const handled = applyAskResponse({
      call_id: "call-2",
      answers: [{ question: "Pick colors", labels: ["Red", "Blue"] }],
    });
    await Bun.sleep(0);

    expect(handled).toBe(true);
    expect(tracked.value()).toEqual({
      declined: false,
      answers: [{ question: "Pick colors", answer: "Red, Blue" }],
    });
  });

  it("uses otherText as the answer when present", async () => {
    const tracked = track(askGroup([question("Pick a color")]));

    const handled = applyAskResponse({
      call_id: "call-3",
      answers: [{ question: "Pick a color", labels: [], otherText: "Chartreuse" }],
    });
    await Bun.sleep(0);

    expect(handled).toBe(true);
    expect(tracked.value()).toEqual({
      declined: false,
      answers: [{ question: "Pick a color", answer: "Chartreuse" }],
    });
  });

  it("keeps selected labels when otherText accompanies them", async () => {
    const tracked = track(askGroup([question("Pick colors")]));

    const handled = applyAskResponse({
      call_id: "call-3b",
      answers: [{ question: "Pick colors", labels: ["Red", "Blue"], otherText: "custom note" }],
    });
    await Bun.sleep(0);

    expect(handled).toBe(true);
    expect(tracked.value()).toEqual({
      declined: false,
      answers: [{ question: "Pick colors", answer: "Red, Blue, custom note" }],
    });
  });

  it("maps declined to the overlay's cancel result", async () => {
    const tracked = track(askGroup([question("Pick a color")]));

    const handled = applyAskResponse({ call_id: "call-4", declined: true });
    await Bun.sleep(0);

    expect(handled).toBe(true);
    expect(tracked.value()).toEqual({ declined: true, reason: "cancel" });
  });

  it("answers all questions of a multi-question group in group order", async () => {
    const tracked = track(askGroup([question("First?"), question("Second?")]));

    const handled = applyAskResponse({
      call_id: "call-5",
      answers: [
        // Deliberately out of order relative to the group.
        { question: "Second?", labels: ["Blue"] },
        { question: "First?", labels: ["Red"] },
      ],
    });
    await Bun.sleep(0);

    expect(handled).toBe(true);
    expect(tracked.value()).toEqual({
      declined: false,
      answers: [
        { question: "First?", answer: "Red" },
        { question: "Second?", answer: "Blue" },
      ],
    });
  });

  it("resolves the matching group when several are pending", async () => {
    const first = track(askGroup([question("Alpha?")]));
    const second = track(askGroup([question("Beta?")]));

    const handled = applyAskResponse({
      call_id: "call-6",
      answers: [{ question: "Beta?", labels: ["Red"] }],
    });
    await Bun.sleep(0);

    expect(handled).toBe(true);
    expect(first.settled()).toBe(false);
    expect(second.value()).toEqual({
      declined: false,
      answers: [{ question: "Beta?", answer: "Red" }],
    });
    expect(pending()).toHaveLength(1);
  });

  it("leaves the group pending when question texts do not match", async () => {
    const tracked = track(askGroup([question("Pick a color")]));

    const handled = applyAskResponse({
      call_id: "call-7",
      answers: [{ question: "Some other question", labels: ["Red"] }],
    });
    await Bun.sleep(0);

    expect(handled).toBe(false);
    expect(tracked.settled()).toBe(false);
    expect(pending()).toHaveLength(1);
  });

  it("ignores malformed payloads without touching the queue", async () => {
    const tracked = track(askGroup([question("Pick a color")]));

    expect(applyAskResponse(null)).toBe(false);
    expect(applyAskResponse("nope")).toBe(false);
    expect(applyAskResponse({})).toBe(false);
    expect(applyAskResponse({ call_id: "x" })).toBe(false);
    expect(applyAskResponse({ call_id: "x", answers: "bad" })).toBe(false);
    expect(applyAskResponse({ call_id: "x", answers: [{ labels: ["Red"] }] })).toBe(false);
    await Bun.sleep(0);

    expect(tracked.settled()).toBe(false);
    expect(pending()).toHaveLength(1);
  });

  it("does not decline when the target is ambiguous", async () => {
    const first = track(askGroup([question("Alpha?")]));
    const second = track(askGroup([question("Beta?")]));

    const handled = applyAskResponse({ call_id: "call-8", declined: true });
    await Bun.sleep(0);

    expect(handled).toBe(false);
    expect(first.settled()).toBe(false);
    expect(second.settled()).toBe(false);
    expect(pending()).toHaveLength(2);
  });
});

describe("ask_response through durable events", () => {
  const session = { id: "session-1", records: [] } as unknown as Session;
  const broker = { dispatch: () => {} } as unknown as Broker;

  it("is accepted by the inbound allowlist", () => {
    expect(isSyncableEvent({ type: "ask_response", payload: { ct: "x" } })).toBe(true);
  });

  it("resolves a pending group via applyIncomingEvent", async () => {
    const tracked = track(askGroup([question("Pick a color")]));

    applyIncomingEvent({
      eventType: "ask_response",
      parsed: { call_id: "call-9", answers: [{ question: "Pick a color", labels: ["Red"] }] },
      session,
      broker,
    });
    await Bun.sleep(0);

    expect(tracked.value()).toEqual({
      declined: false,
      answers: [{ question: "Pick a color", answer: "Red" }],
    });
    expect(pending()).toHaveLength(0);
  });
});
