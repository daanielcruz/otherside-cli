declare module "bidi-js" {
  export interface BidiEmbeddingLevels {
    levels: Uint8Array | number[];
    paragraphs: ReadonlyArray<{ start: number; end: number; level: number }>;
  }

  export interface BidiInstance {
    getEmbeddingLevels(text: string, direction?: "auto" | "ltr" | "rtl"): BidiEmbeddingLevels;
    getReorderSegments(
      text: string,
      embeddingLevels: BidiEmbeddingLevels,
      start?: number,
      end?: number,
    ): Array<[number, number]>;
    getReorderedString(
      text: string,
      embeddingLevels: BidiEmbeddingLevels,
      start?: number,
      end?: number,
    ): string;
    getReorderedIndices(
      text: string,
      embeddingLevels: BidiEmbeddingLevels,
      start?: number,
      end?: number,
    ): number[];
  }

  const bidiFactory: () => BidiInstance;
  export default bidiFactory;
}
