export const PERMISSION_MODES = ["accept-edits", "plan", "yolo", "default"] as const;

export type PermissionMode = (typeof PERMISSION_MODES)[number];
