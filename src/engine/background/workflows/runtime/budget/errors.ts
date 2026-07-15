export class WorkflowBudgetExceededError extends Error {
  constructor(spent: number, total: number) {
    super(
      `Workflow token budget exceeded (${spent.toLocaleString()} / ${total.toLocaleString()} output tokens). Stopping further agent() calls; in-flight agents complete and their results are preserved.`,
    );
    this.name = "WorkflowBudgetExceededError";
  }
}

export function isWorkflowBudgetExceededError(reason: unknown): boolean {
  if (reason instanceof WorkflowBudgetExceededError) return true;
  if (reason === null || typeof reason !== "object") return false;
  return "name" in reason && Reflect.get(reason, "name") === "WorkflowBudgetExceededError";
}

export function enforceWorkflowBudget(budget: { total: number | null; spent: () => number }): void {
  if (budget.total === null || budget.total <= 0) return;
  const spent = budget.spent();
  if (spent < budget.total) return;
  throw new WorkflowBudgetExceededError(spent, budget.total);
}
