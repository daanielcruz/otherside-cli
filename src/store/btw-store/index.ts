export type BtwTurnStatus = "pending" | "answered" | "error" | "cancelled";

/** Backoff surfaced while the side question retries an API error. */
export interface BtwTurnRetry {
  attempt: number;
  maxAttempts: number;
  retryAt: number;
  reason: string;
}

export interface BtwTurn {
  id: string;
  question: string;
  response: string | null;
  synthetic: boolean;
  status: BtwTurnStatus;
  error?: string;
  retry?: BtwTurnRetry;
  startedAt: number;
  endedAt?: number;
}

const store: { turns: BtwTurn[] } = { turns: [] };
let seq = 0;
const subscribers = new Set<() => void>();

function makeId(): string {
  seq = (seq + 1) | 0;
  return `btw_${Date.now().toString(36)}_${seq.toString(36)}`;
}

function notify(): void {
  for (const fn of subscribers) fn();
}

export function listBtwTurns(): BtwTurn[] {
  return store.turns;
}

export function answeredBtwHistory(): { question: string; response: string }[] {
  const out: { question: string; response: string }[] = [];
  for (const t of store.turns) {
    if (t.status === "answered" && t.response !== null) {
      out.push({ question: t.question, response: t.response });
    }
  }
  return out;
}

export function startBtwTurn(question: string): BtwTurn {
  const turn: BtwTurn = {
    id: makeId(),
    question,
    response: null,
    synthetic: false,
    status: "pending",
    startedAt: Date.now(),
  };
  store.turns = [...store.turns, turn];
  notify();
  return turn;
}

export function completeBtwTurn(
  id: string,
  patch: { response: string | null; synthetic: boolean; status: BtwTurnStatus; error?: string },
): void {
  store.turns = store.turns.map((t) => {
    if (t.id !== id) return t;
    const { retry: _dropped, ...rest } = t;
    return { ...rest, ...patch, endedAt: Date.now() };
  });
  notify();
}

export function setBtwTurnRetry(id: string, retry: BtwTurnRetry): void {
  store.turns = store.turns.map((t) => (t.id === id ? { ...t, retry } : t));
  notify();
}

export function clearBtwTurns(keepLast = false): void {
  if (keepLast) {
    const last = store.turns.at(-1);
    store.turns = last ? [last] : [];
  } else {
    store.turns = [];
  }
  notify();
}

export function subscribeBtwTurns(fn: () => void): () => void {
  subscribers.add(fn);
  return () => {
    subscribers.delete(fn);
  };
}
