import * as toolsRegistry from "@/engine/tools/registry.ts";
import type { ToolCall } from "@/kernel/std/types/message.ts";

export function isToolConcurrencySafe(name: string): boolean {
  return toolsRegistry.get(name)?.isConcurrencySafe === true;
}

export function partitionForConcurrency(calls: ToolCall[]): ToolCall[][] {
  const groups: ToolCall[][] = [];
  let safeRun: ToolCall[] = [];
  for (const call of calls) {
    if (isToolConcurrencySafe(call.name)) {
      safeRun.push(call);
      continue;
    }
    if (safeRun.length > 0) {
      groups.push(safeRun);
      safeRun = [];
    }
    groups.push([call]);
  }
  if (safeRun.length > 0) groups.push(safeRun);
  return groups;
}
