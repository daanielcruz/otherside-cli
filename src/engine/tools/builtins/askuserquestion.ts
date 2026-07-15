import type { ToolHandler } from "@/engine/tools/contract.ts";
import { AskUserQuestionSchema } from "@/engine/tools/dynamic/AskUserQuestion.ts";
import { askGroup, type GroupQuestion, type QuestionOption } from "@/kernel/channels/ask.ts";
import type { ToolCall, ToolResult, ToolResultMeta } from "@/kernel/std/types/message.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";

interface InputQuestion {
  question?: unknown;
  header?: unknown;
  options?: unknown;
  multiSelect?: unknown;
}

interface Input {
  questions?: unknown;
}

function err(toolUseId: string, msg: string): ToolResult {
  return { tool_use_id: toolUseId, content: msg, is_error: true };
}

function ok(toolUseId: string, content: string, meta?: ToolResultMeta): ToolResult {
  return { tool_use_id: toolUseId, content, ...(meta ? { meta } : {}) };
}

function parseOptions(raw: unknown): QuestionOption[] {
  if (!Array.isArray(raw)) return [];
  const out: QuestionOption[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const label = typeof e.label === "string" ? e.label : null;
    if (!label) continue;
    const description = typeof e.description === "string" ? e.description : "";
    const preview = typeof e.preview === "string" ? e.preview : undefined;
    out.push({ label, description, ...(preview !== undefined ? { preview } : {}) });
  }
  return out;
}

function parseQuestions(raw: unknown[]): GroupQuestion[] {
  const out: GroupQuestion[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const q = item as InputQuestion;
    const question = typeof q.question === "string" ? q.question : null;
    if (!question) continue;
    const header = typeof q.header === "string" ? q.header : undefined;
    out.push({
      question,
      ...(header !== undefined ? { header } : {}),
      options: parseOptions(q.options),
      multiSelect: q.multiSelect === true,
    });
  }
  return out;
}

export const AskUserQuestion: ToolHandler = {
  schema: {
    name: AskUserQuestionSchema.name,
    description: AskUserQuestionSchema.description,
    inputSchema: AskUserQuestionSchema.inputSchema,
  },
  requiresUserInteraction: () => true,
  async run(call: ToolCall, _ctx: RequestContext): Promise<ToolResult> {
    const args = (call.input ?? {}) as Input;
    if (!Array.isArray(args.questions) || args.questions.length === 0) {
      return err(call.id, "`questions` array (1-4 items) is required");
    }

    const questions = parseQuestions(args.questions);
    if (questions.length === 0) {
      return err(call.id, "no valid questions provided");
    }

    const result = await askGroup(questions);
    if (result.declined) {
      if (result.reason === "chat") {
        return ok(
          call.id,
          "The user wants to clarify these questions before answering. Ask them follow-up questions to gather the information they need, then continue.",
          { kind: "ask", declined: true },
        );
      }
      return ok(call.id, "The user cancelled the questions without answering.", {
        kind: "ask",
        declined: true,
      });
    }

    const parts = result.answers.map(({ question, answer }) => `"${question}"="${answer}"`);
    return ok(
      call.id,
      `User has answered your questions: ${parts.join(", ")}. You can now continue with the user's answers in mind.`,
      { kind: "ask", declined: false, answers: result.answers },
    );
  },
};
