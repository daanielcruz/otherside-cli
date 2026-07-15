export type BtwTurnStatus = "pending" | "answered" | "error" | "cancelled";

export interface BtwTurn {
  id: string;
  question: string;
  response: string | null;
  synthetic: boolean;
  status: BtwTurnStatus;
  error?: string;
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
  store.turns = store.turns.map((t) => (t.id === id ? { ...t, ...patch, endedAt: Date.now() } : t));
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

export function resetBtwStoreForTests(): void {
  store.turns = [];
  seq = 0;
  subscribers.clear();
}
