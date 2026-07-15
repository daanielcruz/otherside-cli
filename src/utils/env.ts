export { env, JETBRAINS_IDES } from "@/kernel/std/env.ts";

export function isTreatedAsTrue(value: string | boolean | undefined | null): boolean {
  if (!value) return false;
  if (typeof value === "boolean") return value;
  const normalized = String(value).toLowerCase().trim();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}
