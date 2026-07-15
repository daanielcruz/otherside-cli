import type { ImageDimensions, ImageMediaType } from "@/kernel/std/types/image.ts";

export interface PastedContent {
  id: number;
  type: "text" | "image";
  content: string;
  mediaType?: ImageMediaType;
  filename?: string;
  dimensions?: ImageDimensions;
  sourcePath?: string;
}

export interface PasteStore {
  add(item: Omit<PastedContent, "id">): { id: number; placeholder: string };
  get(id: number): PastedContent | undefined;
  list(): PastedContent[];
  clear(): void;
}

export interface PasteReference {
  id: number;
  match: string;
  start: number;
  end: number;
}
