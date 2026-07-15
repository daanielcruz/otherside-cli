import { whichSync } from "@/kernel/std/proc/which.ts";

export function findExecutable(exe: string, args: string[]): { cmd: string; args: string[] } {
  const resolved = whichSync(exe);
  return { cmd: resolved ?? exe, args };
}
