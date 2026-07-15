export const EFFORT_LEVEL_VALUES = ["low", "medium", "high", "xhigh", "max"] as const;

export type EffortLevel = (typeof EFFORT_LEVEL_VALUES)[number];
