import { updateSetting } from "@/kernel/config/update-setting.ts";

let cached: string | null | undefined;

export function seedExtraUsageDisabledReason(reason: string | null | undefined): void {
  cached = reason ?? undefined;
}

export async function cachedExtraUsageBlockReason(reason: string | null): Promise<void> {
  if (cached === reason) return;
  cached = reason;
  try {
    await updateSetting("cachedExtraUsageDisabledReason", reason);
  } catch {}
}

type ExtraUsageBlockReason =
  | "out_of_credits"
  | "overage_not_provisioned"
  | "org_level_disabled"
  | "org_level_disabled_until"
  | "seat_tier_level_disabled"
  | "member_level_disabled"
  | "seat_tier_zero_credit_limit"
  | "group_zero_credit_limit"
  | "member_zero_credit_limit"
  | "org_service_level_disabled"
  | "org_service_zero_credit_limit"
  | "no_limits_configured"
  | "unknown";

function isExtraUsageEnabled(): boolean {
  if (cached === undefined) return false;
  if (cached === null) return true;
  if ((cached as ExtraUsageBlockReason) === "out_of_credits") return true;
  return false;
}

export function checkOpus1mAccess(): boolean {
  return true;
}

export function checkSonnet1mAccess(): boolean {
  return isExtraUsageEnabled();
}
