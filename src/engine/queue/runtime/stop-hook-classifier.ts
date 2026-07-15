export const STOP_CONDITION_SYSTEM_PROMPT = `You are evaluating a stop-condition hook in Otherside CLI. Read the conversation transcript carefully, then judge whether the user-provided condition is satisfied.

Your response must be a JSON object with one of these shapes:
- {"ok": true, "reason": "<quote evidence from the transcript that satisfies the condition>"}
- {"ok": false, "reason": "<quote what is missing or what blocks the condition>"}
- {"ok": false, "impossible": true, "reason": "<explain why the condition can never be satisfied>"}

Always include a "reason" field, quoting specific text from the transcript whenever possible. If the transcript does not contain clear evidence that the condition is satisfied, return {"ok": false, "reason": "insufficient evidence in transcript"}.

Only use {"ok": false, "impossible": true} when the condition is genuinely unachievable in this session — for example: the condition is self-contradictory, it depends on a resource or capability that is unavailable, or the assistant has explicitly tried, exhausted reasonable approaches, and stated it cannot be done. Apply your own judgment when deciding this — the assistant claiming the goal is impossible is evidence, not proof; independently confirm the condition is genuinely unachievable rather than deferring to the assistant's self-assessment. Do not use it just because the goal has not been reached yet or because progress is slow. When in doubt, return {"ok": false} without "impossible".`;

export function buildStopConditionUserPrompt(condition: string): string {
  return `Based on the conversation transcript above, has the following stopping condition been satisfied? Answer based on transcript evidence only.

Condition: ${condition}`;
}

export interface StopConditionVerdict {
  ok: boolean;
  reason: string;
  impossible?: boolean;
}

export function parseStopConditionVerdict(raw: string): StopConditionVerdict | null {
  const unfenced = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  let parsed: unknown;
  try {
    parsed = JSON.parse(unfenced);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.ok !== "boolean" || typeof obj.reason !== "string") return null;
  const verdict: StopConditionVerdict = { ok: obj.ok, reason: obj.reason };
  if (obj.impossible === true) verdict.impossible = true;
  return verdict;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const VERDICT_OUTPUT_CONFIG = {
  format: {
    type: "json_schema",
    schema: {
      type: "object",
      properties: {
        ok: { type: "boolean" },
        reason: { type: "string" },
        impossible: { type: "boolean" },
      },
      required: ["ok", "reason"],
      additionalProperties: false,
    },
  },
};

export function clampVerdictRequest(body: unknown): unknown {
  if (!isRecord(body)) return body;
  const next = { ...body };

  if ("contents" in next && "generationConfig" in next && isRecord(next.generationConfig)) {
    const genConfig = { ...next.generationConfig };
    if (isRecord(genConfig.thinkingConfig)) {
      genConfig.thinkingConfig = {
        ...genConfig.thinkingConfig,
        thinkingBudget: 0,
      };
    }
    genConfig.responseMimeType = "application/json";
    genConfig.responseSchema = {
      type: "OBJECT",
      properties: {
        ok: { type: "BOOLEAN" },
        reason: { type: "STRING" },
        impossible: { type: "BOOLEAN" },
      },
      required: ["ok", "reason"],
    };
    next.generationConfig = genConfig;
    next.tools = [];
    return next;
  }

  next.thinking = { type: "disabled" };
  next.tools = [];
  next.output_config = VERDICT_OUTPUT_CONFIG;
  return next;
}

export function stopHookBlockCap(): number {
  const parsed = Number.parseInt(process.env.OTHERSIDE_STOP_HOOK_BLOCK_CAP ?? "", 10);
  return Number.isNaN(parsed) ? STOP_HOOK_BLOCK_CAP_DEFAULT : parsed;
}

const STOP_HOOK_BLOCK_CAP_DEFAULT = 8;
