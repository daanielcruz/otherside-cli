export const MAX_BACKGROUND_OUTPUT_BYTES = 5 * 1024 * 1024 * 1024;

export const BACKGROUND_OUTPUT_LIMIT_NOTICE =
  "Background command exceeded the 5 GiB output limit and was terminated.";

export interface BackgroundOutputLimiterOptions {
  maxBytes: number;
  onExceeded: () => void;
}

export function createBackgroundOutputLimiter(
  opts: BackgroundOutputLimiterOptions,
): (chunk: string) => boolean {
  let bytes = 0;
  let exceeded = false;

  return (chunk: string): boolean => {
    if (exceeded) return false;
    const chunkBytes = Buffer.byteLength(chunk, "utf8");
    if (bytes + chunkBytes <= opts.maxBytes) {
      bytes += chunkBytes;
      return true;
    }
    exceeded = true;
    opts.onExceeded();
    return false;
  };
}
