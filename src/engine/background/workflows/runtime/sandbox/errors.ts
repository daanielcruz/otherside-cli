export function formatWorkflowError(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message;
  if (typeof error === "string" && error.length > 0) return error;
  if (hasMessage(error)) return error.message;
  if (error instanceof Error) return error.constructor.name;
  if (typeof error === "object" && error !== null) return stringifyObject(error);
  if (error !== null && error !== undefined) return String(error);
  return "Unknown workflow error";
}

function stringifyObject(value: object): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function hasMessage(error: unknown): error is { message: string } {
  return (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string" &&
    error.message.length > 0
  );
}

// The filename the compiled workflow script runs under (see compile.ts). Used
// to tell "a frame inside the user script" from a host frame when trimming
// stacks down to something worth surfacing to a task/UI consumer.
export const WORKFLOW_SCRIPT_FILENAME = "workflow-script.js";
const WORKFLOW_ERROR_MAX_FRAMES = 3;

// A boundary-safe error carrier: no prototype at all, so a script cannot ride
// `.constructor` off a thrown value back to the host's real Error/Function.
export interface VmSafeError {
  name: string;
  message: string;
  stack: string;
  toString(): string;
}

export function buildVmSafeError(error: unknown): VmSafeError {
  const message = formatWorkflowError(error);
  const name = errorNameOf(error);
  const safe = Object.create(null) as VmSafeError;
  safe.name = name;
  safe.message = message;
  safe.stack = stackOf(error) ?? `${name}: ${message}`;
  const stringify = () => `${safe.name}: ${safe.message}`;
  Object.setPrototypeOf(stringify, null);
  safe.toString = stringify;
  return safe;
}

function errorNameOf(error: unknown): string {
  if (error instanceof Error && error.name.length > 0) return error.name;
  if (typeof error === "object" && error !== null) {
    const name = Reflect.get(error, "name");
    if (typeof name === "string" && name.length > 0) return name;
  }
  return "Error";
}

function stackOf(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const stack = Reflect.get(error, "stack");
  return typeof stack === "string" && stack.length > 0 ? stack : undefined;
}

export function wrapSyncForVm<Args extends unknown[], Result>(
  fn: (...args: Args) => Result,
): (...args: Args) => Result {
  const wrapped = (...args: Args): Result => {
    try {
      return fn(...args);
    } catch (error) {
      throw buildVmSafeError(error);
    }
  };
  Object.setPrototypeOf(wrapped, null);
  return wrapped;
}

// Failed workflow runs surface this instead of a bare message: the first
// line of the error plus up to WORKFLOW_ERROR_MAX_FRAMES stack frames that
// point into the compiled script, so a task/UI consumer gets an actionable
// line/frame of the throw without a full host+VM mixed stack dump.
export function shortErrorStack(error: unknown): string {
  const message = formatWorkflowError(error);
  const newlineIndex = message.indexOf("\n");
  const firstLine = newlineIndex === -1 ? message : message.slice(0, newlineIndex);
  const stack = stackOf(error);
  if (!stack) return firstLine;
  const frames = stack
    .split("\n")
    .slice(1)
    .map((line) => line.trim())
    .filter((line) => line.includes(WORKFLOW_SCRIPT_FILENAME))
    .slice(0, WORKFLOW_ERROR_MAX_FRAMES);
  return frames.length > 0 ? [firstLine, ...frames].join("\n") : firstLine;
}
