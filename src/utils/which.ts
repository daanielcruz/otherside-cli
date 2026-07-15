import { whichSync } from "@/kernel/std/which.ts";

export function commandExists(command: string): boolean {
  return whichSync(command) !== null;
}
