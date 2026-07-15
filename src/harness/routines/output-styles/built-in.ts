import DEFAULT_MD from "./default.md" with { type: "text" };

export const DEFAULT_OUTPUT_STYLE = "default";

export const BUILT_IN_OUTPUT_STYLES: Readonly<Record<string, string>> = {
  [DEFAULT_OUTPUT_STYLE]: DEFAULT_MD.trim(),
};
