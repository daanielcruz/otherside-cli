export interface SseEvent {
  event?: string;
  data: string;
  id?: string;
  isComment?: boolean;
}

export async function* parseSse(stream: AsyncIterable<Uint8Array>): AsyncIterable<SseEvent> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    while (true) {
      const sep = nextSeparator(buffer);
      if (!sep) break;
      const { idx, length } = sep;
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + length);
      yield parseBlock(block);
    }
  }
  if (buffer.trim().length > 0) yield parseBlock(buffer);
}

function nextSeparator(buffer: string): { idx: number; length: number } | null {
  const lf = buffer.indexOf("\n\n");
  const crlf = buffer.indexOf("\r\n\r\n");
  if (lf < 0 && crlf < 0) return null;
  if (lf < 0) return { idx: crlf, length: 4 };
  if (crlf < 0) return { idx: lf, length: 2 };
  return crlf < lf ? { idx: crlf, length: 4 } : { idx: lf, length: 2 };
}

export function parseBlock(block: string): SseEvent {
  const ev: SseEvent = { data: "" };
  const dataLines: string[] = [];
  let isComment = false;
  for (const rawLine of block.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line.startsWith(":")) {
      isComment = true;
      continue;
    }
    if (line.length === 0) continue;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
    if (field === "data") dataLines.push(value);
    else if (field === "event") ev.event = value;
    else if (field === "id") ev.id = value;
  }
  ev.data = dataLines.join("\n");
  if (isComment) ev.isComment = true;
  return ev;
}
