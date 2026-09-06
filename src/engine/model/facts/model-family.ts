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

// Denylist gate for mid-conversation-system-2026-04-07: the API rejects
// mid-conversation `role:"system"` on haiku ("role 'system' is not supported
// on this model"), so haiku keeps reminders in user blocks and omits the beta.
// Every other first-party model carries the beta and promotes. The unwrap set
// below stays narrower on purpose.
export function modelSupportsMidConversationSystemBeta(base: string): boolean {
  return !isHaikuModel(base);
}

// Only these models receive promoted reminders without the wrapper.
const MID_CONVERSATION_SYSTEM_SUPPORTED: ReadonlySet<string> = new Set([
  "claude-opus-5",
  "claude-opus-4-8",
  "claude-fable-5-1",
]);

export function modelSupportsMidConversationSystem(base: string): boolean {
  return MID_CONVERSATION_SYSTEM_SUPPORTED.has(base);
}

// Haiku main turns clear thinking, too; eligibility is family-scoped.
export function modelHasContextManagement(base: string): boolean {
  return (
    isFableModel(base) ||
    base.includes("claude-opus-4") ||
    base.includes("claude-sonnet-4") ||
    base.includes("claude-sonnet-5") ||
    base.includes("claude-haiku-4") ||
    base.includes("claude-opus-5")
  );
}
