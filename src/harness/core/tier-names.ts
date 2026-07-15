export const TIER_NAMES = ["general", "warrior", "scout"] as const;

export type TierName = (typeof TIER_NAMES)[number];

const TIER_NAME_SET: ReadonlySet<string> = new Set(TIER_NAMES);

export function isTierName(value: unknown): value is TierName {
  return typeof value === "string" && TIER_NAME_SET.has(value);
}
