export const INTERRUPT_MESSAGE = "[Request interrupted by user]";
export const TOOL_INTERRUPT_MESSAGE = "[Request interrupted by user for tool use]";
/** What a tool call the user interrupted returns in place of its result. */
export const TOOL_RESULT_INTERRUPTED = "Interrupted by user";
export const INTERRUPTED_FEEDBACK = "Interrupted · What should Otherside do instead?";

export function isInterruptionMessage(text: string): boolean {
  return text.includes(INTERRUPT_MESSAGE) || text.includes(TOOL_INTERRUPT_MESSAGE);
}

/** A tool result the user's interruption produced rather than the tool. */
export function isInterruptedToolResult(text: string): boolean {
  return text === TOOL_RESULT_INTERRUPTED || isInterruptionMessage(text);
}
