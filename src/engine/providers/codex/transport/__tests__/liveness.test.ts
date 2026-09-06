import { describe, expect, it } from "bun:test";
import { StreamSilenceError } from "@/kernel/std/stream/idle-timeout.ts";
import { createSocketLivenessProbe } from "../liveness.ts";

async function wait(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

describe("Codex socket liveness probe", () => {
  it("fails the socket when a probe ping gets no pong", async () => {
    const pings: number[] = [];
    let dead: StreamSilenceError | null = null;
    const probe = createSocketLivenessProbe(
      { ping: () => pings.push(Date.now()) },
      (err) => {
        dead = err;
      },
      { quietMs: 5, pongDeadlineMs: 5 },
    );
    try {
      await wait(30);
      expect(pings.length).toBe(1);
      expect(dead).toBeInstanceOf(StreamSilenceError);
    } finally {
      probe.dispose();
    }
  });

  it("keeps cycling while pongs answer the probes", async () => {
    let dead: StreamSilenceError | null = null;
    const probe = createSocketLivenessProbe(
      {
        ping: () => {
          queueMicrotask(() => probe.pongReceived());
        },
      },
      (err) => {
        dead = err;
      },
      { quietMs: 5, pongDeadlineMs: 20 },
    );
    try {
      await wait(40);
      expect(dead).toBeNull();
    } finally {
      probe.dispose();
    }
  });

  it("never probes while application frames keep arriving", async () => {
    const pings: number[] = [];
    const probe = createSocketLivenessProbe({ ping: () => pings.push(Date.now()) }, () => {}, {
      quietMs: 100,
      pongDeadlineMs: 5,
    });
    try {
      for (let i = 0; i < 4; i++) {
        await wait(10);
        probe.frameReceived();
      }
      expect(pings.length).toBe(0);
    } finally {
      probe.dispose();
    }
  });

  it("treats an unwritable ping as socket death", async () => {
    let dead: StreamSilenceError | null = null;
    const probe = createSocketLivenessProbe(
      {
        ping: () => {
          throw new Error("socket closed");
        },
      },
      (err) => {
        dead = err;
      },
      { quietMs: 5, pongDeadlineMs: 60_000 },
    );
    try {
      await wait(25);
      expect(dead).toBeInstanceOf(StreamSilenceError);
    } finally {
      probe.dispose();
    }
  });

  it("dispose silences all timers", async () => {
    const pings: number[] = [];
    let dead: StreamSilenceError | null = null;
    const probe = createSocketLivenessProbe(
      { ping: () => pings.push(Date.now()) },
      (err) => {
        dead = err;
      },
      { quietMs: 5, pongDeadlineMs: 5 },
    );
    probe.dispose();
    await wait(30);
    expect(pings.length).toBe(0);
    expect(dead).toBeNull();
  });
});
