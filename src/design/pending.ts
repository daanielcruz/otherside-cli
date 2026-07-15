export type BridgeDecision = "allow" | "deny";

const permissionWaiters = new Map<string, (decision: BridgeDecision) => void>();
const questionWaiters = new Map<string, (answer: string) => void>();
const resolvedQuestions = new Map<string, string>();
const RESOLVED_QUESTION_MAX_COUNT = 64;

export function awaitPermission(requestId: string, signal?: AbortSignal): Promise<BridgeDecision> {
  return new Promise((resolve) => {
    permissionWaiters.set(requestId, resolve);
    signal?.addEventListener(
      "abort",
      () => {
        if (permissionWaiters.delete(requestId)) resolve("deny");
      },
      { once: true },
    );
  });
}

export function resolvePermission(requestId: string, decision: BridgeDecision): boolean {
  const waiter = permissionWaiters.get(requestId);
  if (!waiter) return false;
  permissionWaiters.delete(requestId);
  waiter(decision);
  return true;
}

export function awaitQuestion(requestId: string, signal?: AbortSignal): Promise<string> {
  resolvedQuestions.delete(requestId);
  return new Promise((resolve) => {
    questionWaiters.set(requestId, resolve);
    signal?.addEventListener(
      "abort",
      () => {
        if (questionWaiters.delete(requestId)) resolve("");
      },
      { once: true },
    );
  });
}

export function resolveQuestion(requestId: string, answer: string): boolean {
  const waiter = questionWaiters.get(requestId);
  if (!waiter) return resolvedQuestions.get(requestId) === answer;
  questionWaiters.delete(requestId);
  if (resolvedQuestions.size >= RESOLVED_QUESTION_MAX_COUNT) {
    const oldest = resolvedQuestions.keys().next().value;
    if (oldest) resolvedQuestions.delete(oldest);
  }
  resolvedQuestions.set(requestId, answer);
  waiter(answer);
  return true;
}

export interface ScreenshotPayload {
  data: string;
  mediaType: "image/png";
}

const screenshotWaiters = new Map<string, (payload: ScreenshotPayload | null) => void>();

export function awaitScreenshot(
  requestId: string,
  signal?: AbortSignal,
): Promise<ScreenshotPayload | null> {
  return new Promise((resolve) => {
    screenshotWaiters.set(requestId, resolve);
    signal?.addEventListener(
      "abort",
      () => {
        if (screenshotWaiters.delete(requestId)) resolve(null);
      },
      { once: true },
    );
  });
}

export function resolveScreenshot(requestId: string, payload: ScreenshotPayload | null): boolean {
  const waiter = screenshotWaiters.get(requestId);
  if (!waiter) return false;
  screenshotWaiters.delete(requestId);
  waiter(payload);
  return true;
}

export interface LoadReportPayload {
  ok: boolean;
  errors: string[];
  logs: string[];
}

const loadReportWaiters = new Map<string, (payload: LoadReportPayload | null) => void>();

export function awaitLoadReport(
  requestId: string,
  signal?: AbortSignal,
): Promise<LoadReportPayload | null> {
  return new Promise((resolve) => {
    loadReportWaiters.set(requestId, resolve);
    signal?.addEventListener(
      "abort",
      () => {
        if (loadReportWaiters.delete(requestId)) resolve(null);
      },
      { once: true },
    );
  });
}

export function resolveLoadReport(requestId: string, payload: LoadReportPayload | null): boolean {
  const waiter = loadReportWaiters.get(requestId);
  if (!waiter) return false;
  loadReportWaiters.delete(requestId);
  waiter(payload);
  return true;
}

export interface WebviewLogsPayload {
  logs: string[];
}

const webviewLogsWaiters = new Map<string, (payload: WebviewLogsPayload | null) => void>();

export function awaitWebviewLogs(
  requestId: string,
  signal?: AbortSignal,
): Promise<WebviewLogsPayload | null> {
  return new Promise((resolve) => {
    webviewLogsWaiters.set(requestId, resolve);
    signal?.addEventListener(
      "abort",
      () => {
        if (webviewLogsWaiters.delete(requestId)) resolve(null);
      },
      { once: true },
    );
  });
}

export function resolveWebviewLogs(requestId: string, payload: WebviewLogsPayload | null): boolean {
  const waiter = webviewLogsWaiters.get(requestId);
  if (!waiter) return false;
  webviewLogsWaiters.delete(requestId);
  waiter(payload);
  return true;
}

export interface EvalResultPayload {
  ok: boolean;
  result?: string;
  error?: string;
}

const evalResultWaiters = new Map<string, (payload: EvalResultPayload | null) => void>();

export function awaitEvalResult(
  requestId: string,
  signal?: AbortSignal,
): Promise<EvalResultPayload | null> {
  return new Promise((resolve) => {
    evalResultWaiters.set(requestId, resolve);
    signal?.addEventListener(
      "abort",
      () => {
        if (evalResultWaiters.delete(requestId)) resolve(null);
      },
      { once: true },
    );
  });
}

export function resolveEvalResult(requestId: string, payload: EvalResultPayload | null): boolean {
  const waiter = evalResultWaiters.get(requestId);
  if (!waiter) return false;
  evalResultWaiters.delete(requestId);
  waiter(payload);
  return true;
}
