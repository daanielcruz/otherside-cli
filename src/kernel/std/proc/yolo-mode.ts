// Session-scoped signal mirroring runtime-mode.ts's getRuntimeKind() pattern:
// set once at startup from the parsed CLI flags, read anywhere in the kernel
// without threading permission-mode state through every call site.
//
// Deliberately sourced only from the CLI --yolo/--permission-mode=yolo flags
// (see modes/args.ts), never from project settings or a later in-session
// /permission-mode change. kernel/mcp/config.ts relies on that CLI-only
// provenance to auto-approve a pending project .mcp.json server the way
// upstream's bypass-permissions carve-out does, without letting
// project-controlled state self-approve.
let current = false;

export function setYoloMode(active: boolean): void {
  current = active;
}

export function isYoloMode(): boolean {
  return current;
}
