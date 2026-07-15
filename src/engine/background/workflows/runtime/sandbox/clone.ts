import { runInContext } from "node:vm";

export const MAX_BOUNDARY_ARRAY_LENGTH = 4096;

export type WorkflowBoundaryValue =
  | string
  | number
  | boolean
  | null
  | WorkflowBoundaryValue[]
  | WorkflowBoundaryObject;

export type WorkflowBoundaryObject = { [key: string]: WorkflowBoundaryValue };
export type WorkflowBoundaryClone = WorkflowBoundaryValue | undefined;

const BLOCKED_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const ARRAY_LIMIT_ERROR = Symbol("workflowBoundaryArrayLimit");

export function cloneWorkflowBoundaryValue(value: unknown): WorkflowBoundaryClone {
  return cloneValue(value, new WeakMap(), { hasFunction: false });
}

export interface WorkflowBoundaryCloneResult {
  value: WorkflowBoundaryClone;
  hasFunction: boolean;
}

export function cloneWorkflowBoundaryResult(value: unknown): WorkflowBoundaryCloneResult {
  const state: CloneState = { hasFunction: false };
  const cloned = cloneValue(value, new WeakMap(), state);
  return { value: cloned, hasFunction: state.hasFunction };
}

export function createWorkflowVmBoundaryClone(context: object): (value: unknown) => unknown {
  return runInContext(
    `(() => {
      const seenTag = Symbol("workflowBoundaryArrayLimit");
      const blocked = new Set(["__proto__", "constructor", "prototype"]);
      function limitError(message) {
        const error = new Error(message);
        Object.defineProperty(error, seenTag, { value: true });
        return error;
      }
      function isLimitError(error) {
        try { return typeof error === "object" && error !== null && error[seenTag] === true; }
        catch { return false; }
      }
      return function cloneBoundary(input) {
        const seen = new WeakMap();
        function clone(value) {
          if (typeof value === "function") return undefined;
          if (value === null || typeof value !== "object") return value;
          const cached = seen.get(value);
          if (cached !== undefined) return cached;
          if (Array.isArray(value)) {
            const length = value.length;
            if (!Number.isSafeInteger(length) || length < 0) {
              throw limitError("array length is not a safe integer across the workflow VM boundary");
            }
            if (length > ${MAX_BOUNDARY_ARRAY_LENGTH}) {
              throw limitError("array length " + length + " exceeds the maximum of ${MAX_BOUNDARY_ARRAY_LENGTH} supported across the workflow VM boundary");
            }
            const output = [];
            seen.set(value, output);
            for (let index = 0; index < length; index += 1) {
              try { output[index] = clone(value[index]); }
              catch (error) {
                if (isLimitError(error)) throw error;
                output[index] = undefined;
              }
            }
            return output;
          }
          const output = {};
          seen.set(value, output);
          let keys;
          try { keys = Object.keys(value); }
          catch { return output; }
          for (const key of keys) {
            if (blocked.has(key)) continue;
            try {
              const cloned = clone(value[key]);
              if (cloned !== undefined) {
                Object.defineProperty(output, key, {
                  value: cloned,
                  writable: true,
                  enumerable: true,
                  configurable: true,
                });
              }
            } catch (error) {
              if (isLimitError(error)) throw error;
            }
          }
          return output;
        }
        return clone(input);
      };
    })()`,
    context,
  ) as (value: unknown) => unknown;
}

interface CloneState {
  hasFunction: boolean;
}

function cloneValue(
  value: unknown,
  seen: WeakMap<object, WorkflowBoundaryValue>,
  state: CloneState,
): WorkflowBoundaryClone {
  if (value === null) return null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "function") {
    state.hasFunction = true;
    return undefined;
  }
  if (typeof value !== "object") return undefined;
  if (Array.isArray(value)) return cloneArray(value, seen, state);
  return cloneObject(value, seen, state);
}

function cloneArray(
  value: unknown[],
  seen: WeakMap<object, WorkflowBoundaryValue>,
  state: CloneState,
): WorkflowBoundaryValue[] {
  const cached = seen.get(value);
  if (Array.isArray(cached)) return cached;
  const output: WorkflowBoundaryValue[] = [];
  seen.set(value, output);
  const length = value.length;
  if (!Number.isSafeInteger(length) || length < 0) {
    throw boundaryArrayLimitError(
      "array length is not a safe integer across the workflow boundary",
    );
  }
  if (length > MAX_BOUNDARY_ARRAY_LENGTH) {
    throw boundaryArrayLimitError(
      `array length ${length} exceeds the maximum of ${MAX_BOUNDARY_ARRAY_LENGTH} supported across the workflow boundary`,
    );
  }
  for (let index = 0; index < length; index++) {
    try {
      output.push(cloneValue(value[index], seen, state) ?? null);
    } catch (error) {
      if (isBoundaryArrayLimitError(error)) throw error;
      output.push(null);
    }
  }
  return output;
}

function cloneObject(
  value: object,
  seen: WeakMap<object, WorkflowBoundaryValue>,
  state: CloneState,
): WorkflowBoundaryObject {
  const cached = seen.get(value);
  if (cached && !Array.isArray(cached) && typeof cached === "object") return cached;
  const output: WorkflowBoundaryObject = Object.create(null);
  seen.set(value, output);
  let keys: string[];
  try {
    keys = Object.keys(value);
  } catch {
    return output;
  }
  for (const key of keys) {
    if (BLOCKED_KEYS.has(key)) continue;
    try {
      const cloned = cloneValue(Reflect.get(value, key), seen, state);
      if (cloned !== undefined) output[key] = cloned;
    } catch (error) {
      if (isBoundaryArrayLimitError(error)) throw error;
    }
  }
  return output;
}

function boundaryArrayLimitError(message: string): Error {
  const error = new Error(message);
  Object.defineProperty(error, ARRAY_LIMIT_ERROR, { value: true });
  return error;
}

function isBoundaryArrayLimitError(error: unknown): boolean {
  try {
    return (
      typeof error === "object" && error !== null && Reflect.get(error, ARRAY_LIMIT_ERROR) === true
    );
  } catch {
    return false;
  }
}
