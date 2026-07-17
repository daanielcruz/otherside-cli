import {
  type GroupAnswer,
  type GroupResult,
  type PendingGroup,
  pending,
  resolveGroup,
} from "@/kernel/channels/ask.ts";

interface WireAnswer {
  question: string;
  labels: string[];
  otherText?: string;
}

function parseWireAnswers(raw: unknown): WireAnswer[] | null {
  if (!Array.isArray(raw)) return null;
  const out: WireAnswer[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") return null;
    const e = entry as Record<string, unknown>;
    if (typeof e.question !== "string") return null;
    const labels = Array.isArray(e.labels)
      ? e.labels.filter((l): l is string => typeof l === "string")
      : [];
    const otherText = typeof e.otherText === "string" ? e.otherText : undefined;
    out.push({ question: e.question, labels, ...(otherText !== undefined ? { otherText } : {}) });
  }
  return out;
}

// A group matches when its question texts and the wire answers' question
// texts are equal as sets. This is the safest identity available: the app
// answers against the exact questions JSON it received from the tool_call.
function matchesGroup(group: PendingGroup, answers: WireAnswer[]): boolean {
  const groupQs = new Set(group.questions.map((q) => q.question));
  const answerQs = new Set(answers.map((a) => a.question));
  if (groupQs.size !== answerQs.size) return false;
  for (const q of answerQs) if (!groupQs.has(q)) return false;
  return true;
}

// Labels join with ", " like the terminal overlay's multi-select. The app can
// send labels AND free text together (a state the terminal cannot express) —
// both must survive, so free text appends instead of replacing.
function answerValue(wire: WireAnswer): string {
  const other = wire.otherText?.trim() ?? "";
  return [...wire.labels, other].filter((part) => part.length > 0).join(", ");
}

function buildResult(group: PendingGroup, answers: WireAnswer[]): GroupResult {
  const byQuestion = new Map(answers.map((a) => [a.question, a]));
  const out: GroupAnswer[] = [];
  for (const q of group.questions) {
    const wire = byQuestion.get(q.question);
    if (!wire) continue;
    const value = answerValue(wire);
    if (value.length > 0) out.push({ question: q.question, answer: value });
  }
  return { declined: false, answers: out };
}

// Applies a decrypted `ask_response` event from a companion device. Returns
// true when a pending group was resolved; unknown shapes and events with no
// matching pending group are dropped silently (the terminal user may have
// answered first).
export function applyAskResponse(parsed: unknown): boolean {
  if (!parsed || typeof parsed !== "object") return false;
  const p = parsed as Record<string, unknown>;
  if (typeof p.call_id !== "string" || p.call_id.length === 0) return false;

  const groups = pending();
  if (groups.length === 0) return false;

  if (p.declined === true) {
    // A decline carries no answers to match on; only act when the target is
    // unambiguous.
    if (groups.length !== 1) return false;
    const head = groups[0];
    if (!head) return false;
    return resolveGroup(head.id, { declined: true, reason: "cancel" });
  }

  const answers = parseWireAnswers(p.answers);
  if (!answers || answers.length === 0) return false;
  const matched = groups.find((g) => matchesGroup(g, answers));
  if (!matched) return false;
  return resolveGroup(matched.id, buildResult(matched, answers));
}
