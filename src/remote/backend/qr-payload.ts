import { QR_ALPHANUMERIC_CHARSET } from "@/remote/_infra/qr.ts";
import { type Bytes, uuidBytes } from "@/remote/crypto/e2ee.ts";

const QR_V2_PREFIX = "OS2:";
const QR_V2_VERSION = 2;
const UUID_LEN = 16;
const KEY_LEN = 32;
const FINGERPRINT_LEN = 32;
const PACKED_LEN = 1 + UUID_LEN + KEY_LEN + KEY_LEN + FINGERPRINT_LEN;
const BASE = QR_ALPHANUMERIC_CHARSET.length;
const BASE_SQ = BASE * BASE;

export interface QrV2Fields {
  deviceId: string;
  pub: Bytes;
  nonce: Bytes;
  fingerprintHex: string;
}

export function encodeQrV2(fields: QrV2Fields): string {
  if (fields.pub.length !== KEY_LEN) throw new Error("qr v2: pub must be 32 bytes");
  if (fields.nonce.length !== KEY_LEN) throw new Error("qr v2: nonce must be 32 bytes");
  const fingerprint = hexToBytes(fields.fingerprintHex);
  if (fingerprint.length !== FINGERPRINT_LEN) {
    throw new Error("qr v2: fingerprint must be 32 bytes");
  }
  const packed = new Uint8Array(PACKED_LEN);
  packed[0] = QR_V2_VERSION;
  packed.set(uuidBytes(fields.deviceId), 1);
  packed.set(fields.pub, 1 + UUID_LEN);
  packed.set(fields.nonce, 1 + UUID_LEN + KEY_LEN);
  packed.set(fingerprint, 1 + UUID_LEN + KEY_LEN + KEY_LEN);
  return `${QR_V2_PREFIX}${base45Encode(packed)}`;
}

function hexToBytes(hex: string): Bytes {
  if (hex.length % 2 !== 0) throw new Error("invalid hex");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    const byte = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) throw new Error("invalid hex");
    out[i] = byte;
  }
  return out;
}

function base45Encode(bytes: Bytes): string {
  let out = "";
  let i = 0;
  for (; i + 1 < bytes.length; i += 2) {
    const value = (bytes[i] ?? 0) * 256 + (bytes[i + 1] ?? 0);
    out +=
      charAt(value % BASE) +
      charAt(Math.floor(value / BASE) % BASE) +
      charAt(Math.floor(value / BASE_SQ));
  }
  if (i < bytes.length) {
    const value = bytes[i] ?? 0;
    out += charAt(value % BASE) + charAt(Math.floor(value / BASE));
  }
  return out;
}

function charAt(index: number): string {
  return QR_ALPHANUMERIC_CHARSET.charAt(index);
}
