import { getActiveSessionId } from "@/engine/background/tasks/output-files.ts";
import { formContent, formQuestions, schemaFields } from "@/engine/mcp/elicitation-form.ts";
import { askGroup } from "@/kernel/channels/ask.ts";
import { resolveConfig } from "@/kernel/config/resolver.ts";
import type { EventCtx } from "@/kernel/hooks/events.ts";
import { fireConfiguredHooks } from "@/kernel/hooks/handler.ts";
import { type InboundRequest, registerInboundResponder } from "@/kernel/mcp/protocol/inbound.ts";
import { openBrowser } from "@/kernel/std/browser.ts";

/**
 * A server asking the reader something, and the answer that goes back.
 *
 * The order is the contract: hooks answer first, because a hook exists to make
 * this decision without a person; then the reader; then hooks rule on what the
 * reader said. Whatever happens, one of the three answers goes back — a server
 * left waiting is the failure this whole path exists to prevent.
 */

export const ELICITATION_METHOD = "elicitation/create";

export type ElicitAction = "accept" | "decline" | "cancel";

export interface ElicitResult {
  action: ElicitAction;
  content?: Record<string, unknown>;
}

interface ElicitParams {
  message: string;
  mode: "form" | "url";
  url?: string;
  elicitationId?: string;
  requestedSchema?: Record<string, unknown>;
}

/** Starts answering `elicitation/create`. Returns a teardown. */
export function serveElicitation(): () => void {
  return registerInboundResponder(ELICITATION_METHOD, answerElicitation);
}

async function answerElicitation(request: InboundRequest): Promise<ElicitResult> {
  const params = readParams(request.params);
  if (params === null) return { action: "cancel" };

  const fromHook = await hookAnswer(request.server, params);
  if (fromHook !== undefined) return ruledAnswer(request.server, params, fromHook);
  if (request.signal.aborted) return { action: "cancel" };

  const fromReader = await readerAnswer(params, request.signal);
  return ruledAnswer(request.server, params, fromReader);
}

/**
 * The reader's answer. A url request asks them to visit a page and needs nothing
 * back but their word that they did; a form request asks for values, and the
 * schema says what those may be.
 */
async function readerAnswer(params: ElicitParams, signal: AbortSignal): Promise<ElicitResult> {
  if (params.mode === "url") return urlAnswer(params, signal);
  return formAnswer(params, signal);
}

/**
 * Two questions, because opening a page is not finishing what is on it.
 *
 * The server acts on the answer — granting access, marking something done — so
 * accepting the moment the browser opens would tell it the reader completed
 * something they have not looked at yet. The second question is asked after the
 * page is open and is the one that answers.
 */
async function urlAnswer(params: ElicitParams, signal: AbortSignal): Promise<ElicitResult> {
  const opening = await askGroup([
    {
      question: params.message,
      header: "Open page",
      options: [
        { label: "Open", description: params.url ?? "" },
        { label: "Decline", description: "The server is told no." },
      ],
      multiSelect: false,
    },
  ]);
  if (signal.aborted) return { action: "cancel" };
  if (opening.declined) return { action: opening.reason === "cancel" ? "cancel" : "decline" };
  if (opening.answers[0]?.answer !== "Open") return { action: "decline" };
  if (params.url !== undefined) void openBrowser(params.url);

  const finished = await askGroup([
    {
      question: "Finished on that page?",
      header: "Open page",
      options: [
        { label: "Done", description: "The server is told it went through." },
        { label: "Not done", description: "The server is told it did not." },
      ],
      multiSelect: false,
    },
  ]);
  if (signal.aborted) return { action: "cancel" };
  if (finished.declined) return { action: finished.reason === "cancel" ? "cancel" : "decline" };
  return { action: finished.answers[0]?.answer === "Done" ? "accept" : "decline" };
}

/**
 * A field per property, asked together. A schema declaring nothing answerable is
 * a request for consent rather than for values, so it asks that instead — and
 * answers the server cannot use become a decline rather than a rejected accept.
 */
async function formAnswer(params: ElicitParams, signal: AbortSignal): Promise<ElicitResult> {
  const fields = schemaFields(params.requestedSchema);
  if (fields.length === 0) return consentAnswer(params, signal);

  const questions = formQuestions(fields);
  const result = await askGroup([
    { question: params.message, header: "Server request", options: CONSENT, multiSelect: false },
    ...questions,
  ]);
  if (signal.aborted) return { action: "cancel" };
  if (result.declined) return { action: result.reason === "cancel" ? "cancel" : "decline" };
  if (result.answers[0]?.answer !== ANSWER_LABEL) return { action: "decline" };

  const filled = formContent(fields, questions, result.answers);
  if (!filled.ok || filled.content === undefined) return { action: "decline" };
  return { action: "accept", content: filled.content };
}

/** A request with no fields: the server wants a yes, not a value. */
async function consentAnswer(params: ElicitParams, signal: AbortSignal): Promise<ElicitResult> {
  const result = await askGroup([
    {
      question: params.message,
      header: "Server request",
      options: [
        { label: "Accept", description: "The server is told yes." },
        { label: "Decline", description: "The server is told no." },
      ],
      multiSelect: false,
    },
  ]);
  if (signal.aborted) return { action: "cancel" };
  if (result.declined) return { action: result.reason === "cancel" ? "cancel" : "decline" };
  return { action: result.answers[0]?.answer === "Accept" ? "accept" : "decline" };
}

const ANSWER_LABEL = "Answer";
const CONSENT = [
  { label: ANSWER_LABEL, description: "Fill in what the server asked for." },
  { label: "Decline", description: "The server is told no." },
];

/** A hook's answer, or nothing when no hook spoke for this one. */
async function hookAnswer(server: string, params: ElicitParams): Promise<ElicitResult | undefined> {
  const outcomes = await fireElicitationHooks({
    kind: "elicitation",
    ctx: {
      mcpServerName: server,
      message: params.message,
      mode: params.mode,
      ...(params.url === undefined ? {} : { url: params.url }),
      ...(params.elicitationId === undefined ? {} : { elicitationId: params.elicitationId }),
      ...(params.requestedSchema === undefined ? {} : { requestedSchema: params.requestedSchema }),
      ...sessionAmbient(),
    },
  });
  return answerFromOutcomes(outcomes);
}

/**
 * What the reader said, after the hooks that watch responses have ruled on it.
 * A hook may replace the action or the content; a hook that refuses turns the
 * answer into a decline, because refusing to send a response is not an option.
 */
async function ruledAnswer(
  server: string,
  params: ElicitParams,
  answer: ElicitResult,
): Promise<ElicitResult> {
  const outcomes = await fireElicitationHooks({
    kind: "elicitationResult",
    ctx: {
      mcpServerName: server,
      action: answer.action,
      ...(params.mode === undefined ? {} : { mode: params.mode }),
      ...(params.elicitationId === undefined ? {} : { elicitationId: params.elicitationId }),
      ...(answer.content === undefined ? {} : { content: answer.content }),
      ...sessionAmbient(),
    },
  });
  return answerFromOutcomes(outcomes) ?? answer;
}

async function fireElicitationHooks(event: EventCtx): Promise<{ stdout: string }[]> {
  const config = resolveConfig(process.cwd());
  const outcomes = await fireConfiguredHooks(config, event.kind, event);
  return outcomes.flatMap((outcome) => (outcome.kind === "ok" ? [{ stdout: outcome.stdout }] : []));
}

/**
 * A hook speaks by printing the answer as JSON. Anything else it prints is not
 * an answer, and the next voice in the order gets its turn.
 */
function answerFromOutcomes(outcomes: { stdout: string }[]): ElicitResult | undefined {
  for (const outcome of outcomes) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(outcome.stdout);
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) continue;
    const record = parsed as Record<string, unknown>;
    const action = record.action;
    if (action !== "accept" && action !== "decline" && action !== "cancel") continue;
    const content = record.content;
    return {
      action,
      ...(typeof content === "object" && content !== null && !Array.isArray(content)
        ? { content: content as Record<string, unknown> }
        : {}),
    };
  }
  return undefined;
}

function sessionAmbient(): { sessionId: string; cwd: string } {
  return { sessionId: getActiveSessionId() ?? "", cwd: process.cwd() };
}

export function readParams(raw: unknown): ElicitParams | null {
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;
  const message = record.message;
  if (typeof message !== "string" || message.length === 0) return null;
  const schema = record.requestedSchema;
  const url = record.url;
  const id = record.elicitationId;
  return {
    message,
    mode: record.mode === "url" ? "url" : "form",
    ...(typeof url === "string" ? { url } : {}),
    ...(typeof id === "string" ? { elicitationId: id } : {}),
    ...(typeof schema === "object" && schema !== null && !Array.isArray(schema)
      ? { requestedSchema: schema as Record<string, unknown> }
      : {}),
  };
}
