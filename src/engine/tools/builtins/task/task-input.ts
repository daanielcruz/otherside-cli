function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function applyAlias(obj: Record<string, unknown>, from: string, to: string): void {
  if (!(from in obj)) return;
  if (obj[to] === undefined) obj[to] = obj[from];
  delete obj[from];
}

function normalizeTaskId(obj: Record<string, unknown>, canonical: "taskId" | "task_id"): void {
  for (const variant of ["taskId", "task_id", "id"] as const) {
    if (variant !== canonical) applyAlias(obj, variant, canonical);
  }
}

function semanticBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return undefined;
  const v = value.trim().toLowerCase();
  if (v === "true" || v === "1" || v === "yes") return true;
  if (v === "false" || v === "0" || v === "no") return false;
  return undefined;
}

export function coerceTaskCreateInput(raw: unknown): unknown {
  if (!isRecord(raw)) return raw;
  let obj: Record<string, unknown> = { ...raw };
  if (isRecord(obj.task)) {
    const { task, ...rest } = obj;
    obj = { ...task, ...rest };
    delete obj.task;
  } else if (typeof obj.task === "string") {
    if (obj.subject === undefined) obj.subject = obj.task;
    delete obj.task;
  }
  applyAlias(obj, "title", "subject");
  applyAlias(obj, "name", "subject");
  applyAlias(obj, "content", "description");
  applyAlias(obj, "active_form", "activeForm");
  if (obj.subject === undefined && typeof obj.description === "string") {
    obj.subject = obj.description;
  }
  if (obj.description === undefined && typeof obj.subject === "string") {
    obj.description = obj.subject;
  }
  const allowed = new Set(["subject", "description", "activeForm", "metadata"]);
  const out: Record<string, unknown> = {};
  for (const key of allowed) {
    if (obj[key] !== undefined) out[key] = obj[key];
  }
  return out;
}

export function steerTaskCreateValidation(input: unknown): string | null {
  if (!isRecord(input)) return null;
  const task = isRecord(input.task) ? input.task : null;
  const hasBatch =
    "tasks" in input || "todos" in input || (task !== null && ("tasks" in task || "todos" in task));
  if (hasBatch) {
    return "TaskCreate creates ONE task per call and has no `tasks` or `todos` parameter. Call TaskCreate once per task, passing `subject` (a brief title) and `description` (what needs to be done) as top-level string parameters.";
  }
  const hasAgentParams =
    "prompt" in input ||
    "subagent_type" in input ||
    (task !== null && ("prompt" in task || "subagent_type" in task));
  const hasTaskParams =
    typeof input.subject === "string" &&
    input.subject.trim() !== "" &&
    typeof input.description === "string" &&
    input.description.trim() !== "";
  if (hasAgentParams && !hasTaskParams) {
    return "This call used Agent-tool parameters (`prompt`/`subagent_type`). TaskCreate adds an item to the task list and takes `subject` and `description` string parameters. To delegate work to a subagent, use the Agent tool instead.";
  }
  return null;
}

export function coerceTaskGetInput(raw: unknown): unknown {
  if (!isRecord(raw)) return raw;
  const obj = { ...raw };
  normalizeTaskId(obj, "taskId");
  return obj;
}

export function coerceTaskUpdateInput(raw: unknown): unknown {
  if (!isRecord(raw)) return raw;
  const obj = { ...raw };
  normalizeTaskId(obj, "taskId");
  applyAlias(obj, "active_form", "activeForm");
  return obj;
}

export function coerceTaskStopInput(raw: unknown): unknown {
  if (!isRecord(raw)) return raw;
  const obj = { ...raw };
  normalizeTaskId(obj, "task_id");
  return obj;
}

export function coerceTaskOutputInput(raw: unknown): unknown {
  if (!isRecord(raw)) return raw;
  const obj = { ...raw };
  normalizeTaskId(obj, "task_id");
  if ("block" in obj) {
    const coerced = semanticBoolean(obj.block);
    if (coerced !== undefined) obj.block = coerced;
  }
  return obj;
}
