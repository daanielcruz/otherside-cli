import { existsSync } from "node:fs";
import { extname } from "node:path";
import { isWindows } from "@/kernel/std/proc/platform.ts";

interface LspRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params: unknown;
}

interface LspNotification {
  jsonrpc: "2.0";
  method: string;
  params: unknown;
}

interface LspResponse {
  jsonrpc?: "2.0";
  id?: number | string;
  result?: unknown;
  error?: { code: number; message: string };
  method?: string;
  params?: unknown;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const REQUEST_TIMEOUT_MS = 15_000;

export interface LspServerSpec {
  command: string;
  args: string[];
  languages: string[];
  extensions: string[];
  extensionToLanguage: Record<string, string>;
  env?: Record<string, string>;
  cwd?: string;
}

const BUILTIN_SERVERS: LspServerSpec[] = [
  {
    command: "typescript-language-server",
    args: ["--stdio"],
    languages: ["typescript", "typescriptreact", "javascript", "javascriptreact"],
    extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"],
    extensionToLanguage: {
      ".ts": "typescript",
      ".tsx": "typescriptreact",
      ".js": "javascript",
      ".jsx": "javascriptreact",
      ".mjs": "javascript",
      ".cjs": "javascript",
    },
  },
  {
    command: "pyright-langserver",
    args: ["--stdio"],
    languages: ["python"],
    extensions: [".py"],
    extensionToLanguage: { ".py": "python" },
  },
  {
    command: "rust-analyzer",
    args: [],
    languages: ["rust"],
    extensions: [".rs"],
    extensionToLanguage: { ".rs": "rust" },
  },
  {
    command: "gopls",
    args: ["serve"],
    languages: ["go"],
    extensions: [".go"],
    extensionToLanguage: { ".go": "go" },
  },
];

export interface LspServer {
  spec: LspServerSpec;
  proc: ReturnType<typeof Bun.spawn>;
  writer: WritableStreamDefaultWriter<Uint8Array>;
  initialized: Promise<void>;
  request(method: string, params: unknown): Promise<unknown>;
  notify(method: string, params: unknown): void;
  close(): void;
  rootUri: string;
  openFiles: Map<string, number>;
}

const servers = new Map<string, LspServer>();

// A crash-looping server would otherwise respawn on every request; after the
// cap the language degrades gracefully (getServer returns null).
const MAX_SPAWNS_PER_SERVER = 4;
const spawnCounts = new Map<string, number>();

export function specForFile(
  filePath: string,
  pluginServers: readonly LspServerSpec[] = [],
): LspServerSpec | null {
  const ext = extname(filePath).toLowerCase();
  for (const spec of [...pluginServers, ...BUILTIN_SERVERS]) {
    if (spec.extensions.includes(ext)) return spec;
  }
  return null;
}

async function commandExists(cmd: string): Promise<boolean> {
  const probe = isWindows() ? ["where.exe", cmd] : ["which", cmd];
  const proc = Bun.spawn(probe, { stdout: "pipe", stderr: "ignore" });
  const exitCode = await proc.exited;
  return exitCode === 0;
}

function serverKey(spec: LspServerSpec, rootDir: string): string {
  const env = spec.env ? Object.entries(spec.env).sort(([a], [b]) => a.localeCompare(b)) : [];
  return JSON.stringify({
    command: spec.command,
    args: spec.args,
    rootDir,
    cwd: spec.cwd,
    env,
  });
}

export async function getServer(spec: LspServerSpec, rootDir: string): Promise<LspServer | null> {
  const key = serverKey(spec, rootDir);
  const existing = servers.get(key);
  if (existing) {
    await existing.initialized;
    return existing;
  }
  const spawns = spawnCounts.get(key) ?? 0;
  if (spawns >= MAX_SPAWNS_PER_SERVER) return null;
  if (!(await commandExists(spec.command))) return null;
  spawnCounts.set(key, spawns + 1);

  const spawnOptions: Parameters<typeof Bun.spawn>[1] = {
    cwd: spec.cwd ?? rootDir,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
  };
  if (spec.env !== undefined) {
    spawnOptions.env = { ...process.env, ...spec.env };
  }
  const proc = Bun.spawn([spec.command, ...spec.args], spawnOptions);
  const stdin = proc.stdin as unknown as WritableStream<Uint8Array>;
  const writer = stdin.getWriter();
  let nextId = 1;
  const pending = new Map<number, PendingRequest>();
  let buffer = new Uint8Array(0);
  let closed = false;

  const send = (value: LspRequest | LspNotification): void => {
    const json = JSON.stringify(value);
    const headers = `Content-Length: ${Buffer.byteLength(json)}\r\n\r\n`;
    const bytes = new TextEncoder().encode(headers + json);
    writer.write(bytes).catch(() => (closed = true));
  };

  const request = (method: string, params: unknown): Promise<unknown> => {
    if (closed) return Promise.reject(new Error("LSP server closed"));
    const id = nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`LSP request \`${method}\` timed out`));
      }, REQUEST_TIMEOUT_MS);
      pending.set(id, { resolve, reject, timer });
      send({ jsonrpc: "2.0", id, method, params });
    });
  };

  const notify = (method: string, params: unknown): void => {
    send({ jsonrpc: "2.0", method, params });
  };

  const close = (): void => {
    if (closed) return;
    closed = true;
    for (const [, p] of pending) {
      clearTimeout(p.timer);
      p.reject(new Error("LSP server closed"));
    }
    pending.clear();
    try {
      writer.close().catch(() => {});
    } catch {}
    try {
      proc.kill();
    } catch {}
    servers.delete(key);
  };

  void (async () => {
    const reader = proc.stdout as ReadableStream<Uint8Array>;
    for await (const chunk of reader) {
      const merged = new Uint8Array(buffer.length + chunk.length);
      merged.set(buffer, 0);
      merged.set(chunk, buffer.length);
      buffer = merged;
      while (true) {
        const text = new TextDecoder().decode(buffer);
        const headerEnd = text.indexOf("\r\n\r\n");
        if (headerEnd === -1) break;
        const headers = text.slice(0, headerEnd);
        const m = /Content-Length:\s*(\d+)/i.exec(headers);
        if (!m) {
          buffer = new Uint8Array(0);
          break;
        }
        const len = parseInt(m[1] ?? "0", 10);
        const headerByteLen = Buffer.byteLength(headers) + 4;
        if (buffer.length < headerByteLen + len) break;
        const bodyBytes = buffer.slice(headerByteLen, headerByteLen + len);
        buffer = buffer.slice(headerByteLen + len);
        const body = new TextDecoder().decode(bodyBytes);
        let msg: LspResponse;
        try {
          msg = JSON.parse(body) as LspResponse;
        } catch {
          continue;
        }
        if (typeof msg.id === "number") {
          const p = pending.get(msg.id);
          if (p) {
            pending.delete(msg.id);
            clearTimeout(p.timer);
            if (msg.error) p.reject(new Error(msg.error.message));
            else p.resolve(msg.result ?? null);
          }
        }
      }
    }
    close();
  })().catch(() => close());

  void proc.exited.then(() => close());

  const rootUri = `file://${rootDir}`;
  const initialized = (async () => {
    await request("initialize", {
      processId: process.pid,
      rootUri,
      capabilities: {
        textDocument: {
          definition: { linkSupport: true },
          references: {},
          hover: {},
          documentSymbol: { hierarchicalDocumentSymbolSupport: true },
          implementation: { linkSupport: true },
          callHierarchy: { dynamicRegistration: false },
        },
        workspace: { symbol: {} },
      },
      workspaceFolders: [{ uri: rootUri, name: rootDir.split("/").pop() ?? "root" }],
    });
    notify("initialized", {});
  })();

  const server: LspServer = {
    spec,
    proc,
    writer,
    initialized,
    request,
    notify,
    close,
    rootUri,
    openFiles: new Map(),
  };
  servers.set(key, server);
  try {
    await initialized;
  } catch (err) {
    close();
    throw err;
  }
  return server;
}

export async function ensureFileOpen(server: LspServer, filePath: string): Promise<string> {
  const uri = `file://${filePath}`;
  if (server.openFiles.has(uri)) return uri;
  if (!existsSync(filePath)) throw new Error(`file not found: ${filePath}`);
  const text = await Bun.file(filePath).text();
  const languageId = languageIdFor(filePath, server.spec);
  server.notify("textDocument/didOpen", {
    textDocument: { uri, languageId, version: 1, text },
  });
  server.openFiles.set(uri, 1);
  return uri;
}

function languageIdFor(filePath: string, spec: LspServerSpec): string {
  const ext = extname(filePath).toLowerCase();
  return spec.extensionToLanguage[ext] ?? "plaintext";
}

export function shutdownAll(): void {
  for (const [, server] of servers) server.close();
  servers.clear();
  spawnCounts.clear();
}
