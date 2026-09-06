import type { ToolCall } from "@/kernel/std/types/message.ts";
import type { ProviderId } from "@/kernel/std/types/provider-ids.ts";

export interface AttemptUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
}

/**
 * Everything one request to the provider produced.
 *
 * A provider may re-stream a turn from scratch after partial content, which
 * restarts the same attempt. That makes "discard what this attempt collected"
 * a real operation, and `restart` is its only home: a field added here is
 * cleared there by construction, where a hand-written reset would let the next
 * added field survive a re-send and double the committed message or leave a
 * tool_use block with no matching result.
 */
export class TurnAttempt {
  text = "";
  thinking = "";
  thinkingSignature = "";
  toolCalls: ToolCall[] = [];
  stopReason = "stop";
  refusalExplanation: string | undefined;
  messageId: string | undefined;
  requestId: string | undefined;
  producedProvider: ProviderId | undefined;
  producedModel: string | undefined;
  charCapTripped = false;
  usage: AttemptUsage | null = null;
  providerError: string | undefined;

  restart(): void {
    this.text = "";
    this.thinking = "";
    this.thinkingSignature = "";
    this.toolCalls = [];
    this.stopReason = "stop";
    this.refusalExplanation = undefined;
    this.messageId = undefined;
    this.requestId = undefined;
    this.producedProvider = undefined;
    this.producedModel = undefined;
    this.charCapTripped = false;
    this.usage = null;
    this.providerError = undefined;
  }

  /** The tool names this attempt asked for, as the diagnostics record them. */
  toolCallRefs(): { id: string; name: string }[] {
    return this.toolCalls.map((call) => ({ id: call.id, name: call.name }));
  }

  producedNothing(): boolean {
    return this.text.trim().length === 0 && this.toolCalls.length === 0;
  }
}
