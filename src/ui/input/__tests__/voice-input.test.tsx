import { describe, expect, it, setSystemTime } from "bun:test";
import { useRef } from "react";
import type { VoiceTranscriber, VoiceTranscriberCallbacks } from "@/engine/voice/index.ts";
import type { Key } from "@/ink";
import { Ink } from "@/ink";
import {
  insertVoiceTranscript,
  useVoiceInput,
  type VoiceInputServices,
  voiceCaptureActiveRef,
} from "@/ui/input/use-voice-input.ts";

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
});

const emptyKey: Key = {
  upArrow: false,
  downArrow: false,
  leftArrow: false,
  rightArrow: false,
  pageDown: false,
  pageUp: false,
  wheelUp: false,
  wheelDown: false,
  home: false,
  end: false,
  return: false,
  escape: false,
  ctrl: false,
  shift: false,
  fn: false,
  tab: false,
  backspace: false,
  delete: false,
  meta: false,
  super: false,
};

function key(value: Partial<Key>): Key {
  return { ...emptyKey, ...value };
}

function outputStream(): NodeJS.WriteStream {
  const stream = {
    columns: 80,
    rows: 24,
    isTTY: true,
    write() {
      return true;
    },
    on() {
      return stream;
    },
    off() {
      return stream;
    },
  };
  return stream as unknown as NodeJS.WriteStream;
}

function inputStream(): NodeJS.ReadStream {
  const stream = {
    isTTY: false,
    isRaw: false,
    setRawMode() {},
    listeners: () => [],
    addListener() {
      return stream;
    },
    removeListener() {
      return stream;
    },
    on() {
      return stream;
    },
    off() {
      return stream;
    },
  };
  return stream as unknown as NodeJS.ReadStream;
}

async function flush(ink: Ink): Promise<void> {
  await Promise.resolve();
  await Bun.sleep(0);
  ink.onRender();
}

function voiceHarness(
  services: VoiceInputServices,
  initial: {
    buffer: string;
    cursor: number;
    provider?: "anthropic" | "codex" | "xai" | "antigravity";
    language?: string;
  } = { buffer: "hello world", cursor: 5 },
) {
  let current: ReturnType<typeof useVoiceInput> | null = null;
  let buffer = initial.buffer;
  let cursor = initial.cursor;
  const submitted: string[] = [];
  const refs: {
    buffer?: { current: string };
    cursor?: { current: number };
  } = {};

  function Fixture(): null {
    const bufferRef = useRef(buffer);
    const cursorRef = useRef(cursor);
    refs.buffer = bufferRef;
    refs.cursor = cursorRef;
    current = useVoiceInput(
      {
        provider: initial.provider ?? "anthropic",
        ...(initial.language !== undefined ? { language: initial.language } : {}),
        bufferRef,
        cursorRef,
        setBuffer(value) {
          buffer = value;
          bufferRef.current = value;
        },
        setCursor(value) {
          cursor = value;
          cursorRef.current = value;
        },
        onSubmit(value) {
          submitted.push(value);
        },
        suspended: false,
      },
      services,
    );
    return null;
  }

  const stdout = outputStream();
  const ink = new Ink({
    stdout,
    stdin: inputStream(),
    stderr: outputStream(),
    exitOnCtrlC: true,
    patchConsole: false,
  });
  ink.render(<Fixture />);
  ink.onRender();
  const state = () => {
    if (!current) throw new Error("voice fixture did not render");
    return current;
  };
  return {
    ink,
    state,
    buffer: () => buffer,
    cursor: () => cursor,
    submitted,
    // Mirrors the prompt: a space the hook does not consume is typed, and the
    // prompt's latest-value refs update synchronously with the insertion.
    pressSpace(slashOpen = false): boolean {
      const consumed = state().handleKey(" ", key({}), slashOpen);
      if (!consumed) {
        buffer = buffer.slice(0, cursor) + " " + buffer.slice(cursor);
        cursor += 1;
        if (refs.buffer) refs.buffer.current = buffer;
        if (refs.cursor) refs.cursor.current = cursor;
      }
      return consumed;
    },
    cleanup() {
      (stdout as unknown as { isTTY: boolean }).isTTY = false;
      ink.unmount(null);
    },
  };
}

function idleServices(counters: { started: number; stopped: number; cancelled: number }) {
  const services: VoiceInputServices = {
    connect: async () => ({
      sampleRate: 16_000,
      send() {},
      finish: async () => "ignored",
      cancel() {
        counters.cancelled += 1;
      },
    }),
    startCapture: () => {
      counters.started += 1;
      return {
        stop() {
          counters.stopped += 1;
        },
      };
    },
  };
  return services;
}

describe("voice input state", () => {
  it("types single and double spaces without starting capture", async () => {
    const counters = { started: 0, stopped: 0, cancelled: 0 };
    const harness = voiceHarness(idleServices(counters));
    try {
      expect(harness.pressSpace()).toBe(false);
      expect(harness.buffer()).toBe("hello  world");
      expect(harness.pressSpace()).toBe(false);
      expect(harness.buffer()).toBe("hello   world");
      await flush(harness.ink);
      expect(harness.state().state.phase).toBe("warmup");
      await Bun.sleep(140);
      await flush(harness.ink);
      expect(harness.state().state.phase).toBe("idle");
      expect(counters.started).toBe(0);
    } finally {
      harness.cleanup();
    }
  });

  it("a non-space key resets the hold burst", async () => {
    const counters = { started: 0, stopped: 0, cancelled: 0 };
    const harness = voiceHarness(idleServices(counters));
    try {
      harness.pressSpace();
      harness.pressSpace();
      harness.pressSpace();
      expect(harness.state().handleKey("a", key({}), false)).toBe(false);
      harness.pressSpace();
      harness.pressSpace();
      expect(counters.started).toBe(0);
    } finally {
      harness.cleanup();
    }
  });

  it("holding space engages capture, strips typed spaces, and inserts the transcript", async () => {
    const captured: {
      resolve?: (value: VoiceTranscriber) => void;
      data?: (chunk: Buffer) => void;
      callbacks?: VoiceTranscriberCallbacks;
    } = {};
    let captureStopped = false;
    const sent: Buffer[] = [];
    const services: VoiceInputServices = {
      connect: (_provider, nextCallbacks) => {
        captured.callbacks = nextCallbacks;
        return new Promise((resolve) => {
          captured.resolve = resolve;
        });
      },
      startCapture: (rate, onData) => {
        expect(rate).toBe(16_000);
        captured.data = onData;
        return {
          stop() {
            captureStopped = true;
          },
        };
      },
    };
    const harness = voiceHarness(services);
    try {
      expect(harness.pressSpace()).toBe(false);
      expect(harness.pressSpace()).toBe(false);
      expect(harness.pressSpace()).toBe(true);
      expect(harness.pressSpace()).toBe(true);
      expect(harness.pressSpace()).toBe(true);
      // The two typed warmup spaces are stripped before anchoring.
      expect(harness.buffer()).toBe("hello world");
      expect(harness.cursor()).toBe(5);
      await flush(harness.ink);
      // The meter goes live with the microphone, before the connect resolves.
      expect(harness.state().state.phase).toBe("recording");
      captured.data?.(Buffer.from([1, 2]));
      expect(sent).toHaveLength(0);

      captured.resolve?.({
        sampleRate: 16_000,
        send(chunk: Buffer) {
          sent.push(chunk);
        },
        finish: async () => "dictated",
        cancel() {},
      });
      await flush(harness.ink);
      expect(harness.state().state.phase).toBe("recording");
      expect(sent).toEqual([Buffer.from([1, 2])]);
      captured.callbacks?.onInterim("dictated");
      await flush(harness.ink);
      expect(harness.state().state.preview?.text).toBe("hello dictated world");

      // Space repeats keep the hold alive and are swallowed while engaged.
      expect(harness.pressSpace()).toBe(true);
      await Bun.sleep(140);
      await flush(harness.ink);
      expect(captureStopped).toBe(true);
      expect(harness.buffer()).toBe("hello dictated world");

      // Mid-text insert leaves the cursor away from the end: no double-tap.
      expect(harness.pressSpace()).toBe(false);
      expect(harness.pressSpace()).toBe(false);
      await Bun.sleep(200);
      expect(harness.submitted).toEqual([]);
    } finally {
      harness.cleanup();
    }
  });

  it("sweeps the stray space typed by an initial press whose burst expired", async () => {
    const services: VoiceInputServices = {
      connect: async () => ({
        sampleRate: 16_000,
        send() {},
        finish: async () => "dictated",
        cancel() {},
      }),
      startCapture: () => ({ stop() {} }),
    };
    const harness = voiceHarness(services, { buffer: "hi", cursor: 2 });
    try {
      // Initial press: the key-repeat delay outlives the burst debounce, so
      // its space stays typed and its counter is gone by the time repeats land.
      expect(harness.pressSpace()).toBe(false);
      expect(harness.buffer()).toBe("hi ");
      await Bun.sleep(140);
      for (let press = 0; press < 5; press += 1) harness.pressSpace();
      await flush(harness.ink);
      // The engage sweep also absorbed the expired burst's space.
      expect(harness.buffer()).toBe("hi");
      expect(harness.cursor()).toBe(2);
      await Bun.sleep(140);
      await flush(harness.ink);
      expect(harness.buffer()).toBe("hi dictated");
    } finally {
      harness.cleanup();
    }
  });

  it("keeps the hold alive when a repeat lands after a deferred finish was requested", async () => {
    const captured: { resolve?: (value: VoiceTranscriber) => void } = {};
    let captureStopped = false;
    const services: VoiceInputServices = {
      connect: () =>
        new Promise((resolve) => {
          captured.resolve = resolve;
        }),
      startCapture: () => ({
        stop() {
          captureStopped = true;
        },
      }),
    };
    const harness = voiceHarness(services);
    try {
      for (let press = 0; press < 5; press += 1) harness.pressSpace();
      // Debounce fires during warmup (blocked event loop) → deferred finish.
      await Bun.sleep(140);
      expect(harness.state().state.phase).toBe("recording");
      // A queued repeat proves the hold is still down: it must cancel the
      // deferred finish, not let the connect complete straight into it.
      expect(harness.pressSpace()).toBe(true);
      captured.resolve?.({
        sampleRate: 16_000,
        send() {},
        finish: async () => "alive",
        cancel() {},
      });
      await flush(harness.ink);
      expect(harness.state().state.phase).toBe("recording");
      expect(captureStopped).toBe(false);
      // Real release: no repeat within the debounce window.
      await Bun.sleep(140);
      await flush(harness.ink);
      expect(captureStopped).toBe(true);
      expect(harness.buffer()).toBe("hello alive world");
    } finally {
      harness.cleanup();
    }
  });

  it("double-space submits an end-of-line transcript without the tap space", async () => {
    const services: VoiceInputServices = {
      connect: async () => ({
        sampleRate: 16_000,
        send() {},
        finish: async () => "dictated",
        cancel() {},
      }),
      startCapture: () => ({ stop() {} }),
    };
    const harness = voiceHarness(services, { buffer: "hi", cursor: 2 });
    try {
      for (let press = 0; press < 5; press += 1) harness.pressSpace();
      await flush(harness.ink);
      await Bun.sleep(140);
      await flush(harness.ink);
      expect(harness.buffer()).toBe("hi dictated");

      expect(harness.pressSpace()).toBe(false);
      expect(harness.buffer()).toBe("hi dictated ");
      expect(harness.pressSpace()).toBe(true);
      await Bun.sleep(140);
      expect(harness.submitted).toEqual(["hi dictated"]);
      expect(harness.buffer()).toBe("");
    } finally {
      harness.cleanup();
    }
  });

  it("a second hold right after a transcript never submits the first capture", async () => {
    let take = 0;
    const services: VoiceInputServices = {
      connect: async () => ({
        sampleRate: 16_000,
        send() {},
        finish: async () => {
          take += 1;
          return take === 1 ? "first" : "second";
        },
        cancel() {},
      }),
      startCapture: () => ({ stop() {} }),
    };
    const harness = voiceHarness(services, { buffer: "", cursor: 0 });
    try {
      for (let press = 0; press < 5; press += 1) harness.pressSpace();
      await flush(harness.ink);
      await Bun.sleep(140);
      await flush(harness.ink);
      expect(harness.buffer()).toBe("first");

      // Slow key auto-repeat: the initial press and first repeat look like a
      // double-tap and arm the deferred submit; the next repeat must kill it
      // (a press during the deferral proves a hold, not a tap) so the pending
      // submit cannot fire in an idle gap between slow repeats.
      harness.pressSpace();
      harness.pressSpace();
      harness.pressSpace();
      await Bun.sleep(130);
      expect(harness.submitted).toEqual([]);
      for (let press = 0; press < 5; press += 1) harness.pressSpace();
      await flush(harness.ink);
      expect(harness.state().state.phase).toBe("recording");
      await Bun.sleep(140);
      await flush(harness.ink);
      expect(harness.submitted).toEqual([]);
      expect(harness.buffer()).toBe("first second");
    } finally {
      harness.cleanup();
    }
  });

  it("defers an early release until the transcriber connects", async () => {
    const captured: { resolve?: (value: VoiceTranscriber) => void } = {};
    let captureStopped = false;
    const services: VoiceInputServices = {
      connect: () =>
        new Promise((resolve) => {
          captured.resolve = resolve;
        }),
      startCapture: () => ({
        stop() {
          captureStopped = true;
        },
      }),
    };
    const harness = voiceHarness(services);
    try {
      for (let press = 0; press < 5; press += 1) harness.pressSpace();
      await Bun.sleep(140);
      expect(harness.state().state.phase).toBe("recording");
      expect(captureStopped).toBe(false);

      captured.resolve?.({
        sampleRate: 16_000,
        send() {},
        finish: async () => "early",
        cancel() {},
      });
      await flush(harness.ink);
      await flush(harness.ink);
      expect(captureStopped).toBe(true);
      expect(harness.state().state.phase).toBe("idle");
      expect(harness.buffer()).toBe("hello early world");
    } finally {
      harness.cleanup();
    }
  });

  it("returns to idle silently when a short empty hold releases", async () => {
    const services: VoiceInputServices = {
      connect: async () => ({
        sampleRate: 16_000,
        send() {},
        finish: async () => "",
        cancel() {},
      }),
      startCapture: () => ({ stop() {} }),
    };
    const harness = voiceHarness(services);
    try {
      for (let press = 0; press < 5; press += 1) harness.pressSpace();
      await flush(harness.ink);
      expect(harness.state().state.phase).toBe("recording");
      await Bun.sleep(140);
      await flush(harness.ink);
      expect(harness.state().state.phase).toBe("idle");
      expect(harness.state().state.message).toBeNull();
      expect(harness.buffer()).toBe("hello world");
    } finally {
      harness.cleanup();
    }
  });

  it("warns about missing speech when a long empty hold releases", async () => {
    const services: VoiceInputServices = {
      connect: async () => ({
        sampleRate: 16_000,
        send() {},
        finish: async () => "",
        cancel() {},
      }),
      startCapture: () => ({ stop() {} }),
    };
    const harness = voiceHarness(services);
    try {
      for (let press = 0; press < 5; press += 1) harness.pressSpace();
      await flush(harness.ink);
      expect(harness.state().state.phase).toBe("recording");
      // Jump the clock so the release sees a hold past the warn threshold.
      setSystemTime(new Date(Date.now() + 3_000));
      await Bun.sleep(140);
      await flush(harness.ink);
      expect(harness.state().state.phase).toBe("idle");
      expect(harness.state().state.message).toBe("No speech detected.");
    } finally {
      setSystemTime();
      harness.cleanup();
    }
  });

  it("leaves the slash menu alone and lets Escape discard active capture", async () => {
    const counters = { started: 0, stopped: 0, cancelled: 0 };
    const harness = voiceHarness(idleServices(counters));
    try {
      expect(harness.state().handleKey(" ", key({}), true)).toBe(false);
      expect(counters.started).toBe(0);
      for (let press = 0; press < 5; press += 1) harness.pressSpace();
      await flush(harness.ink);
      expect(counters.started).toBe(1);
      // The global cancel ladder reads this ref to yield Escape to the capture.
      expect(voiceCaptureActiveRef.current).toBe(true);
      expect(harness.state().handleKey("", key({ escape: true }), false)).toBe(true);
      await flush(harness.ink);
      expect(counters.stopped).toBe(1);
      expect(counters.cancelled).toBe(1);
      expect(harness.buffer()).toBe("hello world");
      expect(voiceCaptureActiveRef.current).toBe(false);
    } finally {
      harness.cleanup();
    }
  });

  it("defaults the STT language to English when the general language is unset or auto", async () => {
    const languages: Array<string | null | undefined> = [];
    const services: VoiceInputServices = {
      connect: async (_provider, _callbacks, _signal, options) => {
        languages.push(options?.language);
        return {
          sampleRate: 16_000,
          send() {},
          finish: async () => "",
          cancel() {},
        };
      },
      startCapture: () => ({ stop() {} }),
    };
    for (const language of [undefined, "auto"]) {
      const harness = voiceHarness(services, {
        buffer: "hello world",
        cursor: 5,
        provider: "anthropic",
        ...(language === undefined ? {} : { language }),
      });
      try {
        for (let press = 0; press < 5; press += 1) harness.pressSpace();
        await flush(harness.ink);
      } finally {
        harness.cleanup();
      }
    }
    expect(languages).toEqual(["en", "en"]);
  });

  it("warns when Anthropic clamps a resolved language, and wires English", async () => {
    const languages: Array<string | null | undefined> = [];
    let connectCount = 0;
    const services: VoiceInputServices = {
      connect: async (_provider, _callbacks, _signal, options) => {
        connectCount += 1;
        languages.push(options?.language);
        return {
          sampleRate: 16_000,
          send() {},
          finish: async () => "ok",
          cancel() {},
        };
      },
      startCapture: () => ({ stop() {} }),
    };
    const harness = voiceHarness(services, {
      buffer: "hello world",
      cursor: 5,
      provider: "anthropic",
      language: "vi",
    });
    try {
      for (let press = 0; press < 5; press += 1) harness.pressSpace();
      await flush(harness.ink);
      expect(harness.state().state.message).toBe(
        'Dictation language "vi" is not supported by Anthropic; using English.',
      );
      expect(languages).toEqual(["en"]);
      expect(connectCount).toBe(1);

      // Escape cancels so a second session can start immediately.
      harness.state().handleKey("", key({ escape: true }), false);
      await flush(harness.ink);
      for (let press = 0; press < 5; press += 1) harness.pressSpace();
      await flush(harness.ink);
      // Capture still proceeds with English; clamp warning is once-per-session
      // (message channel already holds the first diagnosis until its timer).
      expect(languages).toEqual(["en", "en"]);
      expect(connectCount).toBe(2);
    } finally {
      harness.cleanup();
    }
  });

  it("uses the general language for Grok without warning", async () => {
    const languages: Array<string | null | undefined> = [];
    const services: VoiceInputServices = {
      connect: async (_provider, _callbacks, _signal, options) => {
        languages.push(options?.language);
        return {
          sampleRate: 16_000,
          send() {},
          finish: async () => "",
          cancel() {},
        };
      },
      startCapture: () => ({ stop() {} }),
    };
    const harness = voiceHarness(services, {
      buffer: "hello world",
      cursor: 5,
      provider: "xai",
      language: "fr",
    });
    try {
      for (let press = 0; press < 5; press += 1) harness.pressSpace();
      await flush(harness.ink);
      expect(harness.state().state.message).toBeNull();
      expect(languages).toEqual(["fr"]);
    } finally {
      harness.cleanup();
    }
  });

  it("warns once for an unresolvable dictation language preference", async () => {
    const languages: Array<string | null | undefined> = [];
    const services: VoiceInputServices = {
      connect: async (_provider, _callbacks, _signal, options) => {
        languages.push(options?.language);
        return {
          sampleRate: 16_000,
          send() {},
          finish: async () => "",
          cancel() {},
        };
      },
      startCapture: () => ({ stop() {} }),
    };
    const harness = voiceHarness(services, {
      buffer: "hello world",
      cursor: 5,
      provider: "anthropic",
      language: "zzz-lang",
    });
    try {
      for (let press = 0; press < 5; press += 1) harness.pressSpace();
      await flush(harness.ink);
      expect(harness.state().state.message).toBe(
        '"zzz-lang" is not a supported dictation language; using English.',
      );
      expect(languages).toEqual(["en"]);
    } finally {
      harness.cleanup();
    }
  });
});
