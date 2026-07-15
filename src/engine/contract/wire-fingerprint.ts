export interface WireFingerprint {
  userAgent: string;
  betaHeaders?: string[];
  extraHeaders: Record<string, string>;
}
