import {
  addressedMessageText,
  enqueue,
  listAgents,
  resolveAgentId,
} from "@/engine/agents/inbox.ts";
import { forkRouteFromRoutingField } from "@/engine/background/subagents/fork/route-override.ts";
import { resumeForkWithMessage } from "@/engine/background/subagents/lifecycle.ts";
import type { ToolHandler } from "@/engine/tools/contract.ts";
import SendMessageSchema from "@/harness/tools/SendMessage/tool.json" with { type: "json" };
import type { ToolCall, ToolResult } from "@/kernel/std/types/message.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";

interface Input {
  to?: unknown;
  message?: unknown;
  reply_to?: unknown;
  routing?: unknown;
}

function err(toolUseId: string, msg: string): ToolResult {
  return { tool_use_id: toolUseId, content: msg, is_error: true };
}

function ok(toolUseId: string, payload: unknown): ToolResult {
  return { tool_use_id: toolUseId, content: JSON.stringify(payload) };
}

export const SendMessage: ToolHandler = {
  schema: {
    name: SendMessageSchema.name,
    description: SendMessageSchema.description,
    inputSchema: SendMessageSchema.inputSchema,
  },
  async run(call: ToolCall, ctx: RequestContext): Promise<ToolResult> {
    const args = (call.input ?? {}) as Input;
    const to = typeof args.to === "string" ? args.to : null;
    const message = typeof args.message === "string" ? args.message : null;
    const replyTo = typeof args.reply_to === "string" ? args.reply_to : undefined;
    if (!to) return err(call.id, "`to` is required");
    if (!message) return err(call.id, "`message` is required");
    const routing = forkRouteFromRoutingField(args.routing);
    if (!routing.ok) return err(call.id, routing.error);

    const resolvedTargetId = resolveAgentId(to);
    const callerId = ctx.agentId ?? ctx.sessionId;
    if (resolvedTargetId === callerId) {
      const selfMsgErr =
        ctx.agentId === undefined
          ? "SendMessage cannot target the caller itself — the main conversation already sees this turn"
          : "SendMessage cannot target the caller itself — this agent already sees this turn";
      return err(call.id, selfMsgErr);
    }

    const from = ctx.agentId ?? "main";

    // A routing field is a decision about the target's route, and the inbox
    // fast path cannot make it — such a message always goes through the
    // lifecycle, which owns the gate, the prompt, and the no-op warning.
    const result = routing.route === undefined ? enqueue(to, message, replyTo, from) : null;
    if (result?.delivered === true) {
      return ok(call.id, {
        delivered: true,
        to: result.agentId,
        messageId: result.messageId,
        resumed: false,
      });
    }

    const resumePrompt = addressedMessageText({ message, from, replyTo });
    const resumed = await resumeForkWithMessage(to, resumePrompt, ctx, routing.route);
    if (resumed.delivered) {
      return ok(call.id, {
        delivered: true,
        to: resumed.agentId,
        resumed: resumed.resumed,
        ...(resumed.warning !== undefined ? { warning: resumed.warning } : {}),
      });
    }

    const known = listAgents()
      .map((agent) => agent.agentId)
      .join(", ");
    return ok(call.id, {
      delivered: false,
      to,
      code: resumed.code,
      reason: resumed.reason,
      knownAgents: known.length > 0 ? known : null,
    });
  },
};
