export const EFFORT_LEVEL_VALUES = ["low", "medium", "high", "xhigh", "max"] as const;

export type EffortLevel = (typeof EFFORT_LEVEL_VALUES)[number];

export function isEffortLevel(value: unknown): value is EffortLevel {
  return typeof value === "string" && (EFFORT_LEVEL_VALUES as readonly string[]).includes(value);
}

/** The level a caller named, or nothing when it named none the catalog knows. */
export function asEffortLevel(value: unknown): EffortLevel | undefined {
  return isEffortLevel(value) ? value : undefined;
}
