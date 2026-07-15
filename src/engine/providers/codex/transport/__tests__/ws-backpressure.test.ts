import { describe, expect, it } from "bun:test";
import {
  CODEX_WS_RECEIVE_QUEUE_HIGH_WATERMARK,
  CODEX_WS_RECEIVE_QUEUE_LOW_WATERMARK,
  CodexWsBackpressureController,
} from "../ws.ts";

class MockSocket {
  pauseCalls = 0;
  resumeCalls = 0;

  pause(): void {
    this.pauseCalls++;
  }

  resume(): void {
    this.resumeCalls++;
  }
}

describe("CodexWsBackpressureController", () => {
  it("does not pause below the high watermark", () => {
    const socket = new MockSocket();
    const controller = new CodexWsBackpressureController(socket);

    for (let i = 0; i < CODEX_WS_RECEIVE_QUEUE_HIGH_WATERMARK; i++) {
      controller.sync(i);
    }
    expect(socket.pauseCalls).toBe(0);
    expect(socket.resumeCalls).toBe(0);
  });

  it("pauses once at the high watermark", () => {
    const socket = new MockSocket();
    const controller = new CodexWsBackpressureController(socket);

    controller.sync(CODEX_WS_RECEIVE_QUEUE_HIGH_WATERMARK - 1);
    expect(socket.pauseCalls).toBe(0);

    controller.sync(CODEX_WS_RECEIVE_QUEUE_HIGH_WATERMARK);
    expect(socket.pauseCalls).toBe(1);

    controller.sync(CODEX_WS_RECEIVE_QUEUE_HIGH_WATERMARK + 1);
    controller.sync(300);
    expect(socket.pauseCalls).toBe(1);
    expect(socket.resumeCalls).toBe(0);
  });

  it("resumes once at the low watermark", () => {
    const socket = new MockSocket();
    const controller = new CodexWsBackpressureController(socket);

    controller.sync(CODEX_WS_RECEIVE_QUEUE_HIGH_WATERMARK);
    expect(socket.pauseCalls).toBe(1);

    for (
      let i = CODEX_WS_RECEIVE_QUEUE_HIGH_WATERMARK - 1;
      i > CODEX_WS_RECEIVE_QUEUE_LOW_WATERMARK;
      i--
    ) {
      controller.sync(i);
    }
    expect(socket.resumeCalls).toBe(0);

    controller.sync(CODEX_WS_RECEIVE_QUEUE_LOW_WATERMARK);
    expect(socket.resumeCalls).toBe(1);

    controller.sync(CODEX_WS_RECEIVE_QUEUE_LOW_WATERMARK - 1);
    controller.sync(CODEX_WS_RECEIVE_QUEUE_LOW_WATERMARK);
    expect(socket.resumeCalls).toBe(1);
  });

  it("resumes a paused socket on dispose", () => {
    const socket = new MockSocket();
    const controller = new CodexWsBackpressureController(socket);

    controller.sync(CODEX_WS_RECEIVE_QUEUE_HIGH_WATERMARK);
    expect(socket.pauseCalls).toBe(1);
    expect(socket.resumeCalls).toBe(0);

    controller.dispose();
    expect(socket.resumeCalls).toBe(1);
  });

  it("does not resume an active socket on dispose", () => {
    const socket = new MockSocket();
    const controller = new CodexWsBackpressureController(socket);

    controller.sync(CODEX_WS_RECEIVE_QUEUE_HIGH_WATERMARK - 1);
    expect(socket.pauseCalls).toBe(0);

    controller.dispose();
    expect(socket.resumeCalls).toBe(0);
  });

  it("holds back bursts until a slow consumer reaches the low watermark", () => {
    const socket = new MockSocket();
    const controller = new CodexWsBackpressureController(socket);

    for (let i = 1; i <= 300; i++) {
      controller.sync(i);
    }
    expect(socket.pauseCalls).toBe(1);
    expect(socket.resumeCalls).toBe(0);

    for (let i = 300; i >= 200; i--) {
      controller.sync(i);
    }
    expect(socket.pauseCalls).toBe(1);
    expect(socket.resumeCalls).toBe(0);

    for (let i = 200; i <= 250; i++) {
      controller.sync(i);
    }
    expect(socket.pauseCalls).toBe(1);
    expect(socket.resumeCalls).toBe(0);

    for (let i = 250; i >= 0; i--) {
      controller.sync(i);
    }
    expect(socket.pauseCalls).toBe(1);
    expect(socket.resumeCalls).toBe(1);
  });
});
