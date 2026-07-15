import { describe, expect, test } from "bun:test";
import { dechunk } from "@/engine/transport/http1-socket.ts";

async function* chunks(...parts: string[]): AsyncGenerator<Buffer> {
  for (const part of parts) yield Buffer.from(part, "latin1");
}

async function collect(src: AsyncIterable<Buffer>): Promise<string> {
  let out = "";
  for (const buf of await Array.fromAsync(src)) out += buf.toString("latin1");
  return out;
}

describe("dechunk", () => {
  test("decodes a well-formed chunked body", async () => {
    const body = await collect(dechunk(chunks("5\r\nhello\r\n6\r\n world\r\n0\r\n\r\n")));
    expect(body).toBe("hello world");
  });

  test("handles a size line split across network chunks", async () => {
    const body = await collect(dechunk(chunks("5\r", "\nhello\r\n", "0\r\n\r\n")));
    expect(body).toBe("hello");
  });

  test("fails fast on a malformed size line instead of spinning", async () => {
    const malformed = dechunk(chunks('{"not":"chunked"}\r\nrest\r\n'));
    await expect(collect(malformed)).rejects.toThrow(/malformed chunk size line/);
  });
});
