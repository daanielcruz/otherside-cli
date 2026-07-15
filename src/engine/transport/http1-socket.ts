import { once } from "node:events";
import { connect as netConnect, type Socket } from "node:net";
import { type TLSSocket, connect as tlsConnect } from "node:tls";
import { createGunzip } from "node:zlib";

const HTTPS_PORT = 443;
const DEFAULT_PROXY_PORT = 8080;
const ALPN = ["http/1.1"];
const CRLF = "\r\n";
const TRANSIENT_RESET_CODE = "ECONNRESET";

function transientTransportError(message: string, cause?: unknown): Error {
  const error = new Error(message, cause ? { cause } : undefined);
  Object.assign(error, { code: TRANSIENT_RESET_CODE });
  return error;
}

export interface Http1Response {
  status: number;
  headers: Map<string, string>;
  body: AsyncIterable<Uint8Array>;
}

export interface Http1RequestInput {
  url: URL;
  headerLines: string[];
  payload: Buffer;
  abortSignal?: AbortSignal;
}

function proxyUrl(): URL | null {
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
  return proxy ? new URL(proxy) : null;
}

async function readUntilHeadersEnd(
  it: AsyncIterator<Buffer>,
): Promise<{ head: string; rest: Buffer }> {
  let buf = Buffer.alloc(0);
  while (true) {
    const end = buf.indexOf("\r\n\r\n");
    if (end >= 0)
      return { head: buf.subarray(0, end).toString("latin1"), rest: buf.subarray(end + 4) };
    const { value, done } = await it.next();
    if (done)
      throw transientTransportError("antigravity transport: connection closed before headers");
    buf = Buffer.concat([buf, value]);
  }
}

async function tunnelThroughProxy(proxy: URL, host: string): Promise<Socket> {
  const raw = netConnect({ host: proxy.hostname, port: Number(proxy.port) || DEFAULT_PROXY_PORT });
  await once(raw, "connect");
  const authority = `${host}:${HTTPS_PORT}`;
  raw.write(`CONNECT ${authority} HTTP/1.1${CRLF}Host: ${authority}${CRLF}${CRLF}`);
  const { head } = await readUntilHeadersEnd(raw[Symbol.asyncIterator]() as AsyncIterator<Buffer>);
  const status = Number.parseInt(head.split(CRLF)[0]?.split(" ")[1] ?? "0", 10);
  if (status !== 200) throw new Error(`antigravity transport: proxy CONNECT failed (${status})`);
  return raw;
}

async function openSocket(url: URL): Promise<TLSSocket> {
  const host = url.hostname;
  const proxy = proxyUrl();
  const tls = proxy
    ? tlsConnect({
        socket: await tunnelThroughProxy(proxy, host),
        servername: host,
        ALPNProtocols: ALPN,
      })
    : tlsConnect({ host, port: HTTPS_PORT, servername: host, ALPNProtocols: ALPN });
  tls.setMaxListeners(0);
  await once(tls, "secureConnect");
  return tls;
}

// Write the request as separate socket.write calls — identical bytes on the
// wire, but no Buffer.concat materializing a full second copy of the payload
// (the request body is 1-2MB of history JSON; the copy was the dominant
// per-request allocation on this transport).
function writeRequest(socket: TLSSocket, url: URL, headerLines: string[], payload: Buffer): void {
  const requestLine = `POST ${url.pathname}${url.search} HTTP/1.1`;
  const head = [requestLine, `Host: ${url.hostname}`, ...headerLines, "", ""].join(CRLF);
  const size = payload.length.toString(16);
  socket.write(Buffer.from(`${head}${size}${CRLF}`, "latin1"));
  socket.write(payload);
  socket.write(Buffer.from(`${CRLF}0${CRLF}${CRLF}`, "latin1"));
}

export async function* dechunk(src: AsyncIterable<Buffer>): AsyncGenerator<Buffer> {
  let buf = Buffer.alloc(0);
  let need = -1;
  for await (const chunk of src) {
    buf = Buffer.concat([buf, chunk]);
    while (true) {
      if (need < 0) {
        const nl = buf.indexOf("\r\n");
        if (nl < 0) break;
        const sizeLine = buf.subarray(0, nl).toString("latin1");
        need = Number.parseInt(sizeLine, 16);
        // A NaN/negative size never satisfies the length check below, so the
        // loop would re-parse the same bytes forever — pinned thread plus
        // unbounded empty-chunk allocation. Fail the stream instead.
        if (!Number.isFinite(need) || need < 0) {
          throw transientTransportError(
            `antigravity transport: malformed chunk size line (${JSON.stringify(sizeLine.slice(0, 32))})`,
          );
        }
        buf = buf.subarray(nl + 2);
        if (need === 0) return;
      }
      if (buf.length < need + 2) break;
      yield buf.subarray(0, need);
      buf = buf.subarray(need + 2);
      need = -1;
    }
  }
}

// Honor writable backpressure (unbounded gz.write buffering pinned whole
// receive buffers during bursts) and destroy the zlib context deterministically
// — native inflate state otherwise strands until GC finalization.
async function* gunzip(src: AsyncIterable<Buffer>): AsyncGenerator<Buffer> {
  const gz = createGunzip();
  // Losing drain/close race listeners accumulate during a backpressure burst
  // (bounded per response, freed on destroy) — keep the default-limit warning
  // off the terminal.
  gz.setMaxListeners(0);
  const writer = (async () => {
    for await (const chunk of src) {
      if (gz.destroyed) return;
      if (!gz.write(chunk)) {
        // Race close so a destroyed context (consumer break) releases the
        // writer instead of leaving it pending on a drain that never comes.
        await Promise.race([once(gz, "drain"), once(gz, "close")]);
        if (gz.destroyed) return;
      }
    }
    gz.end();
  })();
  writer.catch((err) => gz.destroy(err instanceof Error ? err : new Error(String(err))));
  try {
    yield* gz as AsyncIterable<Buffer>;
    await writer;
  } finally {
    gz.destroy();
  }
}

async function* rawBody(rest: Buffer, it: AsyncIterator<Buffer>): AsyncGenerator<Buffer> {
  if (rest.length > 0) yield rest;
  while (true) {
    const { value, done } = await it.next();
    if (done) return;
    yield value;
  }
}

// Destroy the socket whenever the body iteration ends — done, early break, or
// throw. Without this the socket only closes on abort, so a consumer that stops
// reading after the final SSE event leaks the socket + its buffers per request.
async function* withSocketCleanup(
  socket: TLSSocket,
  inner: AsyncIterable<Buffer>,
): AsyncGenerator<Buffer> {
  try {
    yield* inner;
  } finally {
    socket.destroy();
  }
}

function parseHead(head: string): { status: number; headers: Map<string, string> } {
  const lines = head.split(CRLF);
  const status = Number.parseInt(lines[0]?.split(" ")[1] ?? "0", 10);
  const headers = new Map<string, string>();
  for (const line of lines.slice(1)) {
    const i = line.indexOf(":");
    if (i > 0) headers.set(line.slice(0, i).toLowerCase().trim(), line.slice(i + 1).trim());
  }
  return { status, headers };
}

function decodeBody(
  headers: Map<string, string>,
  rest: Buffer,
  it: AsyncIterator<Buffer>,
): AsyncIterable<Buffer> {
  const raw = rawBody(rest, it);
  const dechunked = headers.get("transfer-encoding")?.includes("chunked") ? dechunk(raw) : raw;
  return headers.get("content-encoding")?.includes("gzip") ? gunzip(dechunked) : dechunked;
}

export async function sendChunkedRequest(input: Http1RequestInput): Promise<Http1Response> {
  const socket = await openSocket(input.url);
  const signal = input.abortSignal;
  if (signal) {
    const onAbort = (): void => {
      socket.destroy(new Error("aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    socket.once("close", () => signal.removeEventListener("abort", onAbort));
  }
  writeRequest(socket, input.url, input.headerLines, input.payload);
  const it = socket[Symbol.asyncIterator]() as AsyncIterator<Buffer>;
  try {
    const { head, rest } = await readUntilHeadersEnd(it);
    const { status, headers } = parseHead(head);
    return { status, headers, body: withSocketCleanup(socket, decodeBody(headers, rest, it)) };
  } catch (err) {
    socket.destroy();
    throw err;
  }
}

export async function collectText(body: AsyncIterable<Uint8Array>): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of body) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

const ERROR_BODY_IDLE_MS = 1000;
const ERROR_BODY_HARD_CAP_MS = 8000;
const ERROR_BODY_MAX_BYTES = 64 * 1024;

export async function collectErrorBody(body: AsyncIterable<Uint8Array>): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  const iter = body[Symbol.asyncIterator]() as AsyncIterator<Uint8Array>;
  const hardDeadline = Date.now() + ERROR_BODY_HARD_CAP_MS;
  while (Date.now() < hardDeadline && total < ERROR_BODY_MAX_BYTES) {
    const idleMs = chunks.length > 0 ? ERROR_BODY_IDLE_MS : hardDeadline - Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const idle = new Promise<"idle">((resolve) => {
      timer = setTimeout(() => resolve("idle"), Math.max(0, idleMs));
    });
    const next = await Promise.race([iter.next(), idle]);
    if (timer) clearTimeout(timer);
    if (next === "idle") break;
    if (next.done) break;
    chunks.push(Buffer.from(next.value));
    total += next.value.length;
  }
  void iter.return?.();
  return Buffer.concat(chunks).toString("utf8");
}
