const NOTHING_WAS_APPLIED =
  "The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file).";

/** What a call the user rejected without saying why returns; the turn stops with it. */
export const USER_REJECTED_TOOL_RESULT = `The user doesn't want to proceed with this tool use. ${NOTHING_WAS_APPLIED} STOP what you are doing and wait for the user to tell you how to proceed.`;

/** Leads what a call the user rejected with directions returns; their words follow it. */
export const USER_REJECTED_WITH_FEEDBACK_PREFIX = `The user doesn't want to proceed with this tool use. ${NOTHING_WAS_APPLIED} To tell you how to proceed, the user said:\n`;

/** What an agent's call the user rejected returns: the agent looks for another way. */
export const AGENT_TOOL_REJECTED_RESULT = `Permission for this tool use was denied. ${NOTHING_WAS_APPLIED} Try a different approach or report the limitation to complete your task.`;

/** Leads what an agent's call the user rejected with directions returns. */
export const AGENT_TOOL_REJECTED_WITH_FEEDBACK_PREFIX = `Permission for this tool use was denied. ${NOTHING_WAS_APPLIED} The user said:\n`;

/** What a main-thread call the user rejected with directions returns. */
export function feedbackRejectionText(feedback: string): string {
  return `${USER_REJECTED_WITH_FEEDBACK_PREFIX}${feedback}`;
}

/** What an agent's call the user rejected returns, with their directions when they gave any. */
export function agentRejectionText(feedback: string | undefined): string {
  return feedback
    ? `${AGENT_TOOL_REJECTED_WITH_FEEDBACK_PREFIX}${feedback}`
    : AGENT_TOOL_REJECTED_RESULT;
}

/** A tool result the user's rejection at a permission prompt produced. */
export function isUserRejection(text: string): boolean {
  return (
    text === USER_REJECTED_TOOL_RESULT ||
    text === AGENT_TOOL_REJECTED_RESULT ||
    isFeedbackRejection(text)
  );
}

/** A rejection the user explained, so the model goes on with their directions. */
function isFeedbackRejection(text: string): boolean {
  return (
    text.startsWith(USER_REJECTED_WITH_FEEDBACK_PREFIX) ||
    text.startsWith(AGENT_TOOL_REJECTED_WITH_FEEDBACK_PREFIX)
  );
}
