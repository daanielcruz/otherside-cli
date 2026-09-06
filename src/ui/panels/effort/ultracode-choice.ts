import { EFFORT_LEVEL_VALUES, type EffortLevel } from "@/kernel/std/types/effort.ts";

export type UltracodeEffortChoice = EffortLevel;

const ULTRACODE_EFFORT_CHOICE_SET: ReadonlySet<string> = new Set(EFFORT_LEVEL_VALUES);

export function isUltracodeChoice(level: EffortLevel): level is UltracodeEffortChoice {
  return ULTRACODE_EFFORT_CHOICE_SET.has(level);
}
