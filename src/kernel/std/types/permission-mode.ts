export const PERMISSION_MODES = ["accept-edits", "yolo", "default"] as const;

export type PermissionMode = (typeof PERMISSION_MODES)[number];

// Settings, saved sessions, agent definitions and paired devices can still name
// a mode the product no longer offers; each reads as the mode closest to it.
const RETIRED_MODES: Readonly<Record<string, PermissionMode>> = { plan: "default" };

/** Every stored or typed permission mode passes through here; anything unknown is undefined. */
export function parsePermissionMode(value: unknown): PermissionMode | undefined {
  if (typeof value !== "string") return undefined;
  const known = PERMISSION_MODES.find((mode) => mode === value);
  return known ?? RETIRED_MODES[value];
}
