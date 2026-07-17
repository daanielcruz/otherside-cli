import { describe, expect, it } from "bun:test";
import {
  activityEndMessage,
  activityStartMessage,
  audioMessage,
  grpcFrame,
  parseServerMessage,
  readGrpcFrames,
  setupMessage,
} from "../voice-protobuf.ts";

function lengthField(tag: number, value: Buffer): Buffer {
  return Buffer.concat([Buffer.from([(tag << 3) | 2, value.length]), value]);
}

describe("Gemini voice protobuf", () => {
  it("encodes setup and realtime input messages", () => {
    expect(setupMessage("models/audio").includes(Buffer.from("models/audio"))).toBe(true);
    expect(activityStartMessage()).toEqual(Buffer.from([0x1a, 0x02, 0x2a, 0x00]));
    expect(activityEndMessage()).toEqual(Buffer.from([0x1a, 0x02, 0x32, 0x00]));
    expect(audioMessage(Buffer.from([1, 2])).includes(Buffer.from("audio/pcm;rate=16000"))).toBe(
      true,
    );
  });

  it("parses ready, interim, final, and split gRPC frames", () => {
    expect(parseServerMessage(Buffer.from([0x0a, 0x00]))).toEqual({ type: "ready" });
    const text = lengthField(1, Buffer.from("hello"));
    const interim = lengthField(2, lengthField(11, text));
    expect(parseServerMessage(interim)).toEqual({
      type: "transcript",
      text: "hello",
      final: false,
    });
    const final = lengthField(2, lengthField(6, Buffer.concat([text, Buffer.from([0x10, 0x01])])));
    expect(parseServerMessage(final)).toEqual({
      type: "transcript",
      text: "hello",
      final: true,
    });
    const framed = grpcFrame(final);
    const first = readGrpcFrames(framed.subarray(0, 6));
    expect(first.messages).toHaveLength(0);
    const second = readGrpcFrames(Buffer.concat([first.rest, framed.subarray(6)]));
    expect(second.messages).toEqual([final]);
    expect(second.rest).toHaveLength(0);
  });
});
