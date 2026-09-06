export const EDITOR_MODE_VALUES = ["normal", "vim"] as const;

/** Which key-binding model the prompt input runs under. */
export type EditorMode = (typeof EDITOR_MODE_VALUES)[number];

export const DEFAULT_EDITOR_MODE: EditorMode = "normal";

export function normalizeEditorMode(value: unknown): EditorMode | undefined {
  return EDITOR_MODE_VALUES.includes(value as EditorMode) ? (value as EditorMode) : undefined;
}
