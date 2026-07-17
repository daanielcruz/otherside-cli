// Model-family predicate SoT. The boolean "is this model in family X / does it
// support Y" checks that several layers each need (wire fingerprint, harness
// assembly, request envelope). Co-located here so adding a model to a family is
// one edit, not a hunt across scattered base.includes(...) checks — the flagship
// predicate alone was duplicated byte-for-byte in fingerprint betas and harness
// mid-system gating. The future model registry derives these from per-model
// descriptor flags. Operates on the parsed base id (no [1m] suffix).

export function isHaikuModel(base: string): boolean {
  return base.includes("haiku");
}

export function isFableModel(base: string): boolean {
  return base.includes("claude-fable-5");
}

export function isSonnetModel(base: string): boolean {
  return base.includes("sonnet");
}

// Wire beta allowlist (first-party): haiku denied; sonnet-5 /
// opus-4-8 / fable-5 carry mid-conversation-system-2026-04-07 on agentic mains.
const MID_CONVERSATION_SYSTEM_BETA_SUPPORTED: ReadonlySet<string> = new Set([
  "claude-opus-4-8",
  "claude-fable-5",
  "claude-sonnet-5",
]);

// System-block mid-conversation path stays narrower than the beta: only opus-4-8
// and fable-5 assemble mid-system blocks; sonnet-5 keeps user-message injections
// (sonnet also stays off the mid-system wording latch).
const MID_CONVERSATION_SYSTEM_SUPPORTED: ReadonlySet<string> = new Set([
  "claude-opus-4-8",
  "claude-fable-5",
]);

export function modelSupportsMidConversationSystemBeta(base: string): boolean {
  return MID_CONVERSATION_SYSTEM_BETA_SUPPORTED.has(base);
}

export function modelSupportsMidConversationSystem(base: string): boolean {
  return MID_CONVERSATION_SYSTEM_SUPPORTED.has(base);
}

// The main turn carries context_management on every first-party model: opus-4-8, fable-5, sonnet-5, and haiku-4-5. Haiku main turns include thinking, so their thinking-clearance logic applies. Family-5 prefixes cover future dated variants the same way family-4 prefixes do.
export function modelSupportsContextManagement(base: string): boolean {
  return (
    isFableModel(base) ||
    base.includes("claude-opus-4") ||
    base.includes("claude-sonnet-4") ||
    base.includes("claude-sonnet-5") ||
    base.includes("claude-haiku-4") ||
    base.includes("claude-opus-5")
  );
}
