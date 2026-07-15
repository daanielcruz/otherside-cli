import QRCode, { type QrBitBuffer } from "qrcode-terminal/vendor/QRCode/index.js";
import QRErrorCorrectLevel from "qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel.js";
import QRMode from "qrcode-terminal/vendor/QRCode/QRMode.js";

const QUIET_ZONE = 2;

export const QR_ALPHANUMERIC_CHARSET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:";
const ALPHANUMERIC_PATTERN = /^[0-9A-Z $%*+\-./:]+$/;
const ALPHANUMERIC_BASE = QR_ALPHANUMERIC_CHARSET.length;
const PAIR_BITS = 11;
const SINGLE_BITS = 6;

class AlphanumericSegment {
  readonly mode = QRMode.MODE_ALPHA_NUM;
  private readonly data: string;

  constructor(data: string) {
    this.data = data;
  }

  getLength(): number {
    return this.data.length;
  }

  write(buffer: QrBitBuffer): void {
    let i = 0;
    for (; i + 1 < this.data.length; i += 2) {
      const high = QR_ALPHANUMERIC_CHARSET.indexOf(this.data.charAt(i));
      const low = QR_ALPHANUMERIC_CHARSET.indexOf(this.data.charAt(i + 1));
      buffer.put(high * ALPHANUMERIC_BASE + low, PAIR_BITS);
    }
    if (i < this.data.length) {
      buffer.put(QR_ALPHANUMERIC_CHARSET.indexOf(this.data.charAt(i)), SINGLE_BITS);
    }
  }
}

export function renderQr(data: string): string {
  const qr = new QRCode(-1, QRErrorCorrectLevel.L);
  if (ALPHANUMERIC_PATTERN.test(data)) qr.dataList.push(new AlphanumericSegment(data));
  else qr.addData(data);
  qr.make();
  const count = qr.getModuleCount();
  const span = count + QUIET_ZONE * 2;
  const light = (row: number, col: number): boolean => {
    const moduleRow = row - QUIET_ZONE;
    const moduleCol = col - QUIET_ZONE;
    if (moduleRow < 0 || moduleCol < 0) return true;
    if (moduleRow >= count || moduleCol >= count) return true;
    return !qr.isDark(moduleRow, moduleCol);
  };
  const lines: string[] = [];
  for (let row = 0; row < span; row += 2) {
    let line = "";
    for (let col = 0; col < span; col++) {
      const top = light(row, col);
      const bottom = light(row + 1, col);
      line += top ? (bottom ? "█" : "▀") : bottom ? "▄" : " ";
    }
    lines.push(line);
  }
  return lines.join("\n");
}
