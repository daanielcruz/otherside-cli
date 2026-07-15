declare module "*.md" {
  const content: string;
  export default content;
}

declare module "*.png" {
  const url: string;
  export default url;
}

declare module "qrcode-terminal/vendor/QRCode/index.js" {
  export type QrBitBuffer = {
    buffer: number[];
    length: number;
    put(num: number, length: number): void;
    putBit(bit: boolean): void;
    getLengthInBits(): number;
    getBuffer(): number[];
  };

  export default class QRCode {
    dataList: unknown[];
    constructor(typeNumber: number, errorCorrectLevel: number);
    addData(data: string): void;
    make(): void;
    getModuleCount(): number;
    isDark(row: number, col: number): boolean;
  }
}

interface StructuredSerializeOptions {
  transfer?: ReadonlyArray<unknown>;
}

declare function structuredClone<T>(value: T, options?: StructuredSerializeOptions): T;

declare module "qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel.js" {
  const QRErrorCorrectLevel: {
    readonly L: number;
    readonly M: number;
    readonly Q: number;
    readonly H: number;
  };
  export default QRErrorCorrectLevel;
}

declare module "qrcode-terminal/vendor/QRCode/QRMode.js" {
  const QRMode: Record<string, number>;
  export default QRMode;
}
