export type CanonicalStopReason =
  | "end_turn"
  | "max_tokens"
  | "tool_use"
  | "stop_sequence"
  | "refusal"
  | "pause_turn"
  | "abort"
  | "error";
