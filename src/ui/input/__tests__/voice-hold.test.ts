import { describe, expect, it } from "bun:test";
import type { VoiceTranscriber, VoiceTranscriberCallbacks } from "@/engine/voice/index.ts";
import type { KeyEventData } from "@/terminal-runtime/input/key-decoder.js";
import {
  insertVoiceTranscript,
  VoiceHold,
  type VoiceHoldServices,
  voiceCaptureActiveRef,
} from "@/ui/input/voice-hold.ts";

describe("voice transcript insertion", () => {
  it("preserves text around the captured cursor", () => {
    expect(insertVoiceTranscript({ before: "hello", after: "world" }, "middle")).toEqual({
      text: "hello middle world",
      cursor: "hello middle".length,
      transcriptStart: "hello ".length,
    });
  });

  it("does not add duplicate whitespace", () => {
    expect(insertVoiceTranscript({ before: "hello ", after: " world" }, "  middle  ")).toEqual({
      text: "hello middle world",
      cursor: "hello middle".length,
      transcriptStart: "hello ".length,
    });
  });

  it("keeps the anchor untouched for an empty transcript", () => {
    expect(insertVoiceTranscript({ before: "ab", after: "cd" }, "   ")).toEqual({
      text: "abcd",
      cursor: 2,
      transcriptStart: 2,
    });
  });
});

function spaceKey(count = 1): KeyEventData {
  return {
    kind: "key",
    fn: false,
    name: count === 1 ? "space" : undefined,
    ctrl: false,
    meta: false,
    shift: false,
    option: false,
    super: false,
    sequence: " ".repeat(count),
    raw: " ".repeat(count),
    isPasted: false,
  };
}

function namedKey(name: string, sequence?: string): KeyEventData {
  return {
    kind: "key",
    fn: false,
    name,
    ctrl: false,
    meta: false,
    shift: false,
    option: false,
    super: false,
    sequence,
    raw: sequence,
    isPasted: false,
  };
}

interface Harness {
  hold: VoiceHold;
  state: { buffer: string; cursor: number };
  submitted: string[];
  transcriber: {
    callbacks: VoiceTranscriberCallbacks | null;
    sent: Buffer[];
    finishText: string;
    finished: boolean;
    cancelled: boolean;
  };
  capture: { stopped: boolean; emitChunk(chunk: Buffer): void; emitLevel(level: number): void };
  pressHold(): void;
}

function harness(
  initial: { buffer: string; cursor: number } = { buffer: "hello world", cursor: 5 },
  options: { connectGate?: Promise<void>; provider?: "anthropic" | "xai" | null } = {},
): Harness {
  const state = { ...initial };
  const submitted: string[] = [];
  const transcriber = {
    callbacks: null as VoiceTranscriberCallbacks | null,
    sent: [] as Buffer[],
    finishText: "",
    finished: false,
    cancelled: false,
  };
  let onChunk: ((chunk: Buffer) => void) | null = null;
  let onLevel: ((level: number) => void) | null = null;
  const capture = {
    stopped: false,
    emitChunk(chunk: Buffer) {
      onChunk?.(chunk);
    },
    emitLevel(level: number) {
      onLevel?.(level);
    },
  };
  const services: VoiceHoldServices = {
    resolveRoute: () => ({
      provider: options.provider === undefined ? "anthropic" : options.provider,
      language: undefined,
    }),
    startCapture: (_rate, chunk, level, _error) => {
      onChunk = chunk;
      onLevel = level;
      return {
        stop() {
          capture.stopped = true;
        },
      };
    },
    connect: async (_provider, callbacks): Promise<VoiceTranscriber> => {
      if (options.connectGate) await options.connectGate;
      transcriber.callbacks = callbacks;
      return {
        sampleRate: 16_000,
        send(chunk: Buffer) {
          transcriber.sent.push(chunk);
        },
        async finish() {
          transcriber.finished = true;
          return transcriber.finishText;
        },
        cancel() {
          transcriber.cancelled = true;
        },
      };
    },
  };
  const hold = new VoiceHold(
    {
      buffer: () => state.buffer,
      cursor: () => state.cursor,
      apply: (text, cursor) => {
        state.buffer = text;
        state.cursor = cursor;
      },
      submit: (text) => {
        submitted.push(text);
      },
      requestRender: () => {},
    },
    services,
  );
  return {
    hold,
    state,
    submitted,
    transcriber,
    capture,
    pressHold() {
      for (let press = 0; press < 5; press++) {
        hold.handleKey(spaceKey(), { slashOpen: false, suspended: false });
      }
    },
  };
}

const settle = () => Bun.sleep(0);
const releaseWait = () => Bun.sleep(170);

describe("space push-to-talk", () => {
  it("types the first presses and engages the hold at the threshold", async () => {
    const h = harness({ buffer: "hi", cursor: 2 });
    const opts = { slashOpen: false, suspended: false };
    expect(h.hold.handleKey(spaceKey(), opts)).toBe(false);
    h.state.buffer = "hi ";
    h.state.cursor = 3;
    expect(h.hold.handleKey(spaceKey(), opts)).toBe(false);
    h.state.buffer = "hi  ";
    h.state.cursor = 4;
    expect(h.hold.phase()).toBe("warmup");
    expect(h.hold.handleKey(spaceKey(), opts)).toBe(true);
    expect(h.hold.handleKey(spaceKey(), opts)).toBe(true);
    expect(h.hold.handleKey(spaceKey(), opts)).toBe(true);
    await settle();
    // The engage sweep strips the two typed spaces back off the buffer.
    expect(h.state.buffer).toBe("hi");
    expect(h.state.cursor).toBe(2);
    expect(h.hold.phase()).toBe("recording");
    expect(voiceCaptureActiveRef.current).toBe(true);
    h.hold.dispose();
    expect(voiceCaptureActiveRef.current).toBe(false);
  });

  it("keeps recording while repeats land and finishes on their absence", async () => {
    const h = harness();
    h.pressHold();
    await settle();
    expect(h.hold.phase()).toBe("recording");
    h.transcriber.finishText = "dictated words";
    h.hold.handleKey(spaceKey(), { slashOpen: false, suspended: false });
    await releaseWait();
    expect(h.transcriber.finished).toBe(true);
    expect(h.state.buffer).toBe("hello dictated words world");
    expect(h.hold.phase()).toBe("idle");
  });

  it("buffers chunks before the transcriber connects and flushes after", async () => {
    let open = () => {};
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const h = harness({ buffer: "", cursor: 0 }, { connectGate: gate });
    h.pressHold();
    await settle();
    expect(h.hold.phase()).toBe("recording");
    const chunk = Buffer.from([1, 2]);
    h.capture.emitChunk(chunk);
    expect(h.transcriber.sent).toHaveLength(0);
    open();
    await settle();
    await settle();
    expect(h.transcriber.sent).toEqual([chunk]);
    h.hold.dispose();
  });

  it("defers the finish when released before the connect resolves", async () => {
    let open = () => {};
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const h = harness({ buffer: "", cursor: 0 }, { connectGate: gate });
    h.transcriber.finishText = "late text";
    h.pressHold();
    await settle();
    // Release passes with no transcriber: the finish waits for the connect.
    await releaseWait();
    expect(h.hold.phase()).toBe("recording");
    open();
    await settle();
    await settle();
    await settle();
    expect(h.transcriber.finished).toBe(true);
    expect(h.state.buffer).toBe("late text");
    h.hold.dispose();
  });

  it("escape cancels the capture and keeps the buffer", async () => {
    const h = harness({ buffer: "keep me", cursor: 7 });
    h.pressHold();
    await settle();
    expect(h.hold.phase()).toBe("recording");
    expect(h.hold.handleKey(namedKey("escape"), { slashOpen: false, suspended: false })).toBe(true);
    expect(h.hold.phase()).toBe("idle");
    expect(h.capture.stopped).toBe(true);
    expect(h.state.buffer).toBe("keep me");
    expect(voiceCaptureActiveRef.current).toBe(false);
  });

  it("stays inert while the slash menu is open or in shell mode", () => {
    const h = harness();
    for (let press = 0; press < 6; press++) {
      expect(h.hold.handleKey(spaceKey(), { slashOpen: true, suspended: false })).toBe(false);
    }
    expect(h.hold.phase()).toBe("idle");
    for (let press = 0; press < 6; press++) {
      expect(h.hold.handleKey(spaceKey(), { slashOpen: false, suspended: true })).toBe(false);
    }
    expect(h.hold.phase()).toBe("idle");
  });

  it("does not engage without a voice provider", async () => {
    const h = harness({ buffer: "", cursor: 0 }, { provider: null });
    h.pressHold();
    await settle();
    expect(h.hold.phase()).toBe("idle");
  });

  it("interim transcript projects a dimmed preview without touching the buffer", async () => {
    const h = harness({ buffer: "note", cursor: 4 });
    h.pressHold();
    await settle();
    h.transcriber.callbacks?.onInterim("partial words");
    const preview = h.hold.preview();
    expect(preview).toEqual({
      text: "note partial words",
      cursor: "note partial words".length,
      transcriptStart: "note ".length,
    });
    expect(h.state.buffer).toBe("note");
    h.hold.dispose();
  });

  it("submits on a deferred double tap after a transcript lands", async () => {
    const h = harness({ buffer: "", cursor: 0 });
    h.pressHold();
    await settle();
    h.transcriber.finishText = "send this";
    await releaseWait();
    expect(h.state.buffer).toBe("send this");
    const opts = { slashOpen: false, suspended: false };
    // First tap types a space; the second within the window defers the submit.
    expect(h.hold.handleKey(spaceKey(), opts)).toBe(false);
    h.state.buffer = "send this ";
    h.state.cursor = h.state.buffer.length;
    expect(h.hold.handleKey(spaceKey(), opts)).toBe(true);
    await releaseWait();
    expect(h.submitted).toEqual(["send this"]);
    expect(h.state.buffer).toBe("");
  });

  it("a press during the submit deferral cancels the submit", async () => {
    const h = harness({ buffer: "", cursor: 0 });
    h.pressHold();
    await settle();
    h.transcriber.finishText = "not yet";
    await releaseWait();
    const opts = { slashOpen: false, suspended: false };
    expect(h.hold.handleKey(spaceKey(), opts)).toBe(false);
    h.state.buffer = "not yet ";
    h.state.cursor = h.state.buffer.length;
    expect(h.hold.handleKey(spaceKey(), opts)).toBe(true);
    // A third press lands while the submit is deferred: it proves a hold.
    h.hold.handleKey(spaceKey(), opts);
    await releaseWait();
    expect(h.submitted).toEqual([]);
    h.hold.dispose();
  });

  it("a non-space key resets the burst and the pending submit", async () => {
    const h = harness({ buffer: "", cursor: 0 });
    const opts = { slashOpen: false, suspended: false };
    h.hold.handleKey(spaceKey(), opts);
    h.hold.handleKey(spaceKey(), opts);
    expect(h.hold.phase()).toBe("warmup");
    h.hold.handleKey(namedKey("a", "a"), opts);
    expect(h.hold.phase()).toBe("idle");
  });

  it("meter cell only renders during recording", async () => {
    const h = harness();
    expect(h.hold.meterCell()).toBeNull();
    h.pressHold();
    await settle();
    expect(h.hold.phase()).toBe("recording");
    const cell = h.hold.meterCell();
    expect(cell).not.toBeNull();
    expect(cell?.char.length).toBe(1);
    h.hold.dispose();
    expect(h.hold.meterCell()).toBeNull();
  });
});
