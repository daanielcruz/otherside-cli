export const INTERRUPT_MESSAGE = "[Request interrupted by user]";
export const TOOL_INTERRUPT_MESSAGE = "[Request interrupted by user for tool use]";
export const INTERRUPTED_FEEDBACK = "Interrupted · What should Otherside do instead?";

export function isInterruptionMessage(text: string): boolean {
  return text.includes(INTERRUPT_MESSAGE) || text.includes(TOOL_INTERRUPT_MESSAGE);
}
