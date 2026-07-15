import type { Message } from "@/kernel/std/types/message.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";
import { composeForkSystem, composeForkUserBlock } from "./compose.ts";

export function buildForkMessages(
  ctx: RequestContext,
  name: string,
  body: string,
  prompt: string,
  skillMessages?: Message[],
): Message[] {
  return [
    {
      role: "system",
      content: composeForkSystem({ ctx, name, body, firstPrompt: prompt }),
    },
    ...(skillMessages ?? []),
    { role: "user", content: [composeForkUserBlock(ctx.provider, prompt)] },
  ];
}
