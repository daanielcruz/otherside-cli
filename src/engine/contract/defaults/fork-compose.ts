import type { ForkSystemInput } from "@/engine/contract/types.ts";
import type { ContentBlock } from "@/kernel/std/types/message.ts";

export function defaultComposeForkSystem(input: ForkSystemInput): ContentBlock[] {
  const sysBody = input.body.trim().length > 0 ? input.body : `You are the ${input.name} fork.`;
  const folded = input.envTail ? `${sysBody}\n\n${input.envTail}` : sysBody;
  return [{ type: "text", text: folded }];
}

export function defaultComposeForkUserBlock(prompt: string): ContentBlock {
  return { type: "text", text: prompt };
}
