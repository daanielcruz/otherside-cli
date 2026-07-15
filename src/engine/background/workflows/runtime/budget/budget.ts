export interface WorkflowBudgetState {
  total: number | null;
  spent: () => number;
  remaining: () => number;
}

export interface WorkflowTokenMeter {
  add: (outputTokens: number) => void;
  spent: () => number;
}

export function createWorkflowTokenMeter(initialSpent = 0): WorkflowTokenMeter {
  let spent =
    typeof initialSpent === "number" && Number.isFinite(initialSpent) && initialSpent > 0
      ? Math.floor(initialSpent)
      : 0;
  return {
    add: (outputTokens) => {
      if (Number.isFinite(outputTokens) && outputTokens > 0) {
        spent += Math.floor(outputTokens);
      }
    },
    spent: () => spent,
  };
}

export function createWorkflowBudget(input: {
  total?: number | null;
  meter: WorkflowTokenMeter;
}): WorkflowBudgetState {
  const total = typeof input.total === "number" && input.total > 0 ? input.total : null;
  return {
    total,
    spent: () => input.meter.spent(),
    remaining: () =>
      total === null ? Number.POSITIVE_INFINITY : Math.max(0, total - input.meter.spent()),
  };
}

export function readWorkflowBudgetTotal(args: unknown): number | null {
  if (args === null || typeof args !== "object" || Array.isArray(args)) return null;
  const tokenBudget = "tokenBudget" in args ? Reflect.get(args, "tokenBudget") : undefined;
  const fallback = "budget" in args ? Reflect.get(args, "budget") : undefined;
  const candidate = tokenBudget ?? fallback;
  if (typeof candidate === "number" && Number.isFinite(candidate) && candidate > 0) {
    return Math.floor(candidate);
  }
  return null;
}
