/**
 * Bridge for mutating `/plugin` slash commands → Plugins panel feedback.
 *
 * Mutating handlers run the op, stash the result here, then open the overlay.
 * The panel consumes the message on mount so feedback renders inside the panel
 * instead of only on the transcript.
 */

let pendingCommandResult: string | null = null;

export function setPendingPluginCommandResult(message: string): void {
  const trimmed = message.trim();
  pendingCommandResult = trimmed.length > 0 ? trimmed : null;
}

export function peekPendingPluginCommandResult(): string | null {
  return pendingCommandResult;
}

export function consumePendingPluginCommandResult(): string | null {
  const message = pendingCommandResult;
  pendingCommandResult = null;
  return message;
}

export function clearPendingPluginCommandResult(): void {
  pendingCommandResult = null;
}
