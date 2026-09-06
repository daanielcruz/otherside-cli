import { describe, expect, test } from "bun:test";
import { QR_ALPHANUMERIC_CHARSET } from "@/backend/app/qr.ts";
import { encodeQrV2, encodeQrV3 } from "@/backend/app/qr-payload.ts";

const DEVICE_ID = "12345678-1234-4567-89ab-123456789abc";
const BASE = QR_ALPHANUMERIC_CHARSET.length;

function base45Decode(encoded: string): Uint8Array {
  const bytes: number[] = [];
  for (let index = 0; index < encoded.length; ) {
    const remaining = encoded.length - index;
    const first = QR_ALPHANUMERIC_CHARSET.indexOf(encoded[index] ?? "");
    const second = QR_ALPHANUMERIC_CHARSET.indexOf(encoded[index + 1] ?? "");
    if (remaining >= 3) {
      const third = QR_ALPHANUMERIC_CHARSET.indexOf(encoded[index + 2] ?? "");
      const value = first + second * BASE + third * BASE * BASE;
      bytes.push(Math.floor(value / 256), value % 256);
      index += 3;
      continue;
    }
    bytes.push(first + second * BASE);
    index += 2;
  }
  return Uint8Array.from(bytes);
}

describe("pairing QR payload", () => {
  test("v3 appends the user code to the v2 binary pack", () => {
    const payload = encodeQrV3({
      deviceId: DEVICE_ID,
      pub: new Uint8Array(32).fill(1),
      nonce: new Uint8Array(32).fill(2),
      fingerprintHex: "03".repeat(32),
      userCode: "ABCD-2345",
    });

    expect(payload.startsWith("OS3:")).toBe(true);
    const packed = base45Decode(payload.slice("OS3:".length));
    expect(packed.length).toBe(122);
    expect(packed[0]).toBe(3);
    expect(new TextDecoder().decode(packed.slice(-9))).toBe("ABCD-2345");
  });

  test("keeps the v2 encoder wire-compatible", () => {
    const payload = encodeQrV2({
      deviceId: DEVICE_ID,
      pub: new Uint8Array(32).fill(1),
      nonce: new Uint8Array(32).fill(2),
      fingerprintHex: "03".repeat(32),
    });

    expect(payload.startsWith("OS2:")).toBe(true);
    const packed = base45Decode(payload.slice("OS2:".length));
    expect(packed.length).toBe(113);
    expect(packed[0]).toBe(2);
  });

  test("rejects user codes outside the backend format", () => {
    expect(() =>
      encodeQrV3({
        deviceId: DEVICE_ID,
        pub: new Uint8Array(32),
        nonce: new Uint8Array(32),
        fingerprintHex: "00".repeat(32),
        userCode: "invalid",
      }),
    ).toThrow("XXXX-XXXX");
  });
});
