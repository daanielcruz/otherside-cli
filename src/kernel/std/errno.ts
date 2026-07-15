export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function errnoCode(err: unknown): string | null {
  if (err === null || typeof err !== "object") return null;
  const value = (err as { code?: unknown }).code;
  return typeof value === "string" ? value : null;
}

export function isErrno(err: unknown, code: string): boolean {
  return errnoCode(err) === code;
}
