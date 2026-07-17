function varint(value: number): Buffer {
  const bytes: number[] = [];
  let remaining = value >>> 0;
  while (remaining >= 0x80) {
    bytes.push((remaining & 0x7f) | 0x80);
    remaining >>>= 7;
  }
  bytes.push(remaining);
  return Buffer.from(bytes);
}

function bytesField(field: number, value: Buffer): Buffer {
  return Buffer.concat([varint((field << 3) | 2), varint(value.length), value]);
}

function stringField(field: number, value: string): Buffer {
  return bytesField(field, Buffer.from(value));
}

function boolField(field: number, value: boolean): Buffer {
  return Buffer.concat([varint(field << 3), varint(value ? 1 : 0)]);
}

const empty = Buffer.alloc(0);

export function setupMessage(model: string): Buffer {
  const language = bytesField(2, empty);
  const activityDetection = boolField(1, true);
  const realtimeConfig = bytesField(6, activityDetection);
  const setup = Buffer.concat([
    stringField(1, model),
    bytesField(5, realtimeConfig),
    bytesField(8, language),
  ]);
  return bytesField(1, setup);
}

export function activityStartMessage(): Buffer {
  return bytesField(3, bytesField(5, empty));
}

export function audioMessage(data: Buffer): Buffer {
  const blob = Buffer.concat([stringField(1, "audio/pcm;rate=16000"), bytesField(2, data)]);
  return bytesField(3, bytesField(1, blob));
}

export function activityEndMessage(): Buffer {
  return bytesField(3, bytesField(6, empty));
}

interface DecodedField {
  field: number;
  wire: number;
  bytes?: Buffer;
  number?: number;
}

function readVarint(buffer: Buffer, offset: number): [number, number] {
  let value = 0;
  let shift = 0;
  let cursor = offset;
  while (cursor < buffer.length) {
    const byte = buffer[cursor++] ?? 0;
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return [value >>> 0, cursor];
    shift += 7;
    if (shift > 35) break;
  }
  throw new Error("invalid protobuf varint");
}

function decode(buffer: Buffer): DecodedField[] {
  const fields: DecodedField[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    const [key, afterKey] = readVarint(buffer, offset);
    offset = afterKey;
    const field = key >>> 3;
    const wire = key & 7;
    if (wire === 0) {
      const [number, next] = readVarint(buffer, offset);
      fields.push({ field, wire, number });
      offset = next;
    } else if (wire === 2) {
      const [length, afterLength] = readVarint(buffer, offset);
      const end = afterLength + length;
      if (end > buffer.length) throw new Error("truncated protobuf field");
      fields.push({ field, wire, bytes: buffer.subarray(afterLength, end) });
      offset = end;
    } else if (wire === 1) {
      offset += 8;
    } else if (wire === 5) {
      offset += 4;
    } else {
      throw new Error(`unsupported protobuf wire type ${wire}`);
    }
  }
  return fields;
}

function nested(buffer: Buffer, field: number): Buffer | null {
  return decode(buffer).find((candidate) => candidate.field === field)?.bytes ?? null;
}

export function parseServerMessage(
  buffer: Buffer,
): { type: "ready" } | { type: "transcript"; text: string; final: boolean } | null {
  if (nested(buffer, 1)) return { type: "ready" };
  const content = nested(buffer, 2);
  if (!content) return null;
  const finalTranscript = nested(content, 6);
  const interimTranscript = nested(content, 11);
  const transcript = finalTranscript ?? interimTranscript;
  if (!transcript) return null;
  const fields = decode(transcript);
  const text = fields.find((field) => field.field === 1)?.bytes?.toString("utf8") ?? "";
  const finished = fields.find((field) => field.field === 2)?.number === 1;
  return { type: "transcript", text, final: finalTranscript !== null && finished };
}

export function grpcFrame(message: Buffer): Buffer {
  const header = Buffer.allocUnsafe(5);
  header[0] = 0;
  header.writeUInt32BE(message.length, 1);
  return Buffer.concat([header, message]);
}

export function readGrpcFrames(buffer: Buffer): { messages: Buffer[]; rest: Buffer } {
  const messages: Buffer[] = [];
  let offset = 0;
  while (buffer.length - offset >= 5) {
    if (buffer[offset] !== 0) throw new Error("compressed gRPC voice frames are unsupported");
    const length = buffer.readUInt32BE(offset + 1);
    if (buffer.length - offset - 5 < length) break;
    messages.push(buffer.subarray(offset + 5, offset + 5 + length));
    offset += 5 + length;
  }
  return { messages, rest: buffer.subarray(offset) };
}
