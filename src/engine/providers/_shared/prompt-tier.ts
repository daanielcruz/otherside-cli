import { isLeanModel } from "@/engine/model/tier/tiers.ts";
import type { ProviderId } from "@/kernel/config/provider-ids.ts";
import { isEnvDefinedFalsy, isEnvTruthy } from "@/kernel/std/proc/env.ts";

const EAP_SUFFIX = /-eap($|\[)/i;

export function isLeanPromptForModel(provider: ProviderId, model: string | undefined): boolean {
  if (!model) return false;
  const env = process.env.OTHERSIDE_SIMPLE_SYSTEM_PROMPT;
  if (isEnvTruthy(env)) return true;
  if (isEnvDefinedFalsy(env)) return false;
  if (EAP_SUFFIX.test(model)) return true;
  return isLeanModel(provider, model);
}
