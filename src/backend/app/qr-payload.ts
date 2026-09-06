import { QR_ALPHANUMERIC_CHARSET } from "@/backend/app/qr.ts";
import { type Bytes, uuidBytes } from "@/backend/shared/e2ee.ts";

const QR_V2_PREFIX = "OS2:";
const QR_V3_PREFIX = "OS3:";
const QR_V2_VERSION = 2;
const QR_V3_VERSION = 3;
const UUID_LEN = 16;
const KEY_LEN = 32;
const FINGERPRINT_LEN = 32;
const USER_CODE_LEN = 9;
const CORE_PACKED_LEN = 1 + UUID_LEN + KEY_LEN + KEY_LEN + FINGERPRINT_LEN;
const BASE = QR_ALPHANUMERIC_CHARSET.length;
const BASE_SQ = BASE * BASE;
const USER_CODE_PATTERN = /^[A-Z2-9]{4}-[A-Z2-9]{4}$/;
const TEXT_ENCODER = new TextEncoder();

export interface QrV2Fields {
  deviceId: string;
  pub: Bytes;
  nonce: Bytes;
  fingerprintHex: string;
}

export interface QrV3Fields extends QrV2Fields {
  userCode: string;
}

export function encodeQrV2(fields: QrV2Fields): string {
  return `${QR_V2_PREFIX}${base45Encode(packCore(fields, QR_V2_VERSION))}`;
}

export function encodeQrV3(fields: QrV3Fields): string {
  const userCode = fields.userCode.toUpperCase();
  if (!USER_CODE_PATTERN.test(userCode)) {
    throw new Error("qr v3: user code must use XXXX-XXXX format");
  }
  const packed = new Uint8Array(CORE_PACKED_LEN + USER_CODE_LEN);
  packed.set(packCore(fields, QR_V3_VERSION));
  packed.set(TEXT_ENCODER.encode(userCode), CORE_PACKED_LEN);
  return `${QR_V3_PREFIX}${base45Encode(packed)}`;
}

function packCore(fields: QrV2Fields, version: number): Uint8Array {
  if (fields.pub.length !== KEY_LEN) throw new Error("qr: pub must be 32 bytes");
  if (fields.nonce.length !== KEY_LEN) throw new Error("qr: nonce must be 32 bytes");
  const fingerprint = hexToBytes(fields.fingerprintHex);
  if (fingerprint.length !== FINGERPRINT_LEN) {
    throw new Error("qr: fingerprint must be 32 bytes");
  }
  const packed = new Uint8Array(CORE_PACKED_LEN);
  packed[0] = version;
  packed.set(uuidBytes(fields.deviceId), 1);
  packed.set(fields.pub, 1 + UUID_LEN);
  packed.set(fields.nonce, 1 + UUID_LEN + KEY_LEN);
  packed.set(fingerprint, 1 + UUID_LEN + KEY_LEN + KEY_LEN);
  return packed;
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
