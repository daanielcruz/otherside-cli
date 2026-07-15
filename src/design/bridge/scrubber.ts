const PATTERNS: RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{4,}/g,
  /\bsk-[A-Za-z0-9]{16,}/g,
  /Bearer\s+[A-Za-z0-9._-]+/g,
  /ya29\.[A-Za-z0-9._-]+/g,
  /xox[bp]-[A-Za-z0-9-]+/g,
  /gh[pous]_[A-Za-z0-9]{16,}/g,
  /AKIA[0-9A-Z]{12,}/g,
];

export function scrub(payload: string): { ok: true } | { ok: false; matched: string } {
  for (const pattern of PATTERNS) {
    const m = payload.match(pattern);
    if (m && m.length > 0) {
      return { ok: false, matched: m[0] };
    }
  }
  return { ok: true };
}
