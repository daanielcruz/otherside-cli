export function truncateEllipsis(value: string, max: number): string {
  if (value.length <= max) return value;
  if (max <= 1) return value.slice(0, max);
  return `${value.slice(0, max - 1)}…`;
}

export function truncateBytesAnnotated(text: string, maxBytes: number): string {
  if (text.length <= maxBytes) return text.trimEnd();
  return `${text.slice(0, maxBytes).trimEnd()}\n[... truncated ${text.length - maxBytes} bytes ...]`;
}

export function capitalize(value: string): string {
  if (value.length === 0) return value;
  return `${value[0]?.toUpperCase() ?? ""}${value.slice(1)}`;
}

export function capUtf8ToBytes(content: string, maxBytes: number): string | Buffer {
  if (Buffer.byteLength(content, "utf8") <= maxBytes) return content;
  return Buffer.from(content, "utf8").subarray(0, maxBytes);
}
