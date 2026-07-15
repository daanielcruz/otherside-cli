export type RuntimeKind = "interactive" | "print" | "piped" | null;

let current: RuntimeKind = null;

export function setRuntimeKind(k: RuntimeKind): void {
  current = k;
}

export function getRuntimeKind(): RuntimeKind {
  return current;
}
