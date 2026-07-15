import { createHash } from "node:crypto";
import { CLAUDE_CODE_VERSION } from "./_infra/fingerprint.ts";
import { CCH_PLACEHOLDER } from "./cch.ts";

const FINGERPRINT_SALT = "59cf53e54c78";
const FINGERPRINT_CHAR_INDICES = [4, 7, 20];

function attributionFingerprint(firstMessageText: string): string {
  const chars = FINGERPRINT_CHAR_INDICES.map((i) => firstMessageText[i] || "0").join("");
  return createHash("sha256")
    .update(`${FINGERPRINT_SALT}${chars}${CLAUDE_CODE_VERSION}`)
    .digest("hex")
    .slice(0, 3);
}

function billingHeader(
  firstMessageText: string,
  subagent: boolean,
  previousRequestId?: string,
): string {
  const version = `${CLAUDE_CODE_VERSION}.${attributionFingerprint(firstMessageText)}`;
  const subagentTail = subagent ? " cc_is_subagent=true;" : "";
  const previousRequestTail = previousRequestId ? ` cc_prev_req=${previousRequestId};` : "";
  return `x-anthropic-billing-header: cc_version=${version}; cc_entrypoint=cli; cch=${CCH_PLACEHOLDER};${subagentTail}${previousRequestTail}`;
}

export function systemBillingHeader(firstMessageText = "", previousRequestId?: string): string {
  return billingHeader(firstMessageText, false, previousRequestId);
}

export function subagentBillingHeader(firstMessageText = "", previousRequestId?: string): string {
  return billingHeader(firstMessageText, true, previousRequestId);
}

export const SYSTEM_OPENER = "You are Claude Code, Anthropic's official CLI for Claude.";

export const SUBAGENT_OPENER = "You are a Claude agent, built on Anthropic's Claude Agent SDK.";
