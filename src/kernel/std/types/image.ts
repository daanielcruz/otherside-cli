export type ImageMediaType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

export interface ImageDimensions {
  originalWidth?: number;
  originalHeight?: number;
  displayWidth?: number;
  displayHeight?: number;
}
