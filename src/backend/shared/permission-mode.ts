import type { PermissionMode } from "@/kernel/std/types/request.ts";

export function appPermissionMode(mode: PermissionMode): "accept" | "auto" | "plan" | "yolo" {
  if (mode === "accept-edits") return "accept";
  if (mode === "default") return "auto";
  return mode;
}
