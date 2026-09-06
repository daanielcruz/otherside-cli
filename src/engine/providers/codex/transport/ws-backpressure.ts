import type { WebSocket as WsClient } from "ws";

/**
 * Receive-side flow control: pauses the socket when the undelivered frame
 * queue grows past the high watermark and resumes below the low one.
 */

export const CODEX_WS_RECEIVE_QUEUE_HIGH_WATERMARK = 256;
export const CODEX_WS_RECEIVE_QUEUE_LOW_WATERMARK = 64;

export interface WsBackpressureController {
  sync(queueLength: number): void;
  dispose(): void;
}

export class CodexWsBackpressureController implements WsBackpressureController {
  private paused = false;
  constructor(private socket: Pick<WsClient, "pause" | "resume">) {}

  sync(queueLength: number): void {
    if (!this.paused && queueLength >= CODEX_WS_RECEIVE_QUEUE_HIGH_WATERMARK) {
      this.socket.pause();
      this.paused = true;
    } else if (this.paused && queueLength <= CODEX_WS_RECEIVE_QUEUE_LOW_WATERMARK) {
      this.socket.resume();
      this.paused = false;
    }
  }

  dispose(): void {
    if (this.paused) {
      try {
        this.socket.resume();
      } catch {}
      this.paused = false;
    }
  }
}
