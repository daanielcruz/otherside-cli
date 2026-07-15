export function uuidv4(): string {
  return crypto.randomUUID();
}

export function uuidv7(now = Date.now()): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let timestamp = BigInt(Math.trunc(now));
  for (let i = 5; i >= 0; i--) {
    bytes[i] = Number(timestamp & 0xffn);
    timestamp >>= 8n;
  }
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function shortId(prefix = ""): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return prefix ? `${prefix}_${hex}` : hex;
}

const TASK_ID_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

export type TaskIdPrefix = "a" | "b" | "r" | "t" | "w" | "m" | "d";

export function generateTaskId(prefix: TaskIdPrefix): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  let id = prefix;
  for (let i = 0; i < 8; i++) {
    const b = bytes[i] ?? 0;
    id += TASK_ID_ALPHABET[b % TASK_ID_ALPHABET.length];
  }
  return id;
}
