import { emitDiagnosticOutput } from "@/utils/debug.js";

export function warnIfNotInteger(value: number | undefined, name: string): void {
  if (value === undefined) return;
  if (Number.isInteger(value)) return;
  emitDiagnosticOutput(`${name} should be an integer, got ${value}`, {
    level: "warn",
  });
}
