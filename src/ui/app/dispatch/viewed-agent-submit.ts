import { resumeViewedAgent, steerViewedAgent } from "@/engine/background/subagents/view-input.ts";
import { get as getBackgroundTask } from "@/engine/background/tasks/background.ts";
import type { Agent } from "@/engine/queue/index.ts";
import type { PasteStore } from "@/kernel/std/types/paste.ts";
import type { MutableRef } from "@/kernel/std/types/state.ts";
import { appStore } from "@/store/app-store/index.ts";
import { expandToContentBlocks } from "@/ui/input/paste/references.ts";

export interface ViewedAgentSubmitDeps {
  agent: Agent;
  pasteStoreRef: MutableRef<PasteStore>;
  /** Transcript feedback when a message cannot reach the viewed agent. */
  showUndeliverable: (reason: string) => void;
}

/**
 * Routes a submitted prompt to the agent whose document is open. The prompt
 * header names that agent as the addressee, so its text must land on the
 * agent's own thread: a running agent takes it as a steer at its next turn
 * boundary; a finished one re-runs under the same transcript and panel row.
 * Answers false only while no agent document is open — the main conversation
 * owns the text then. An open document with an unreachable agent reports
 * instead of falling through: silently rerouting an addressed message to the
 * main conversation is the leak this module exists to close.
 */
export async function submitToViewedAgent(
  text: string,
  deps: ViewedAgentSubmitDeps,
): Promise<boolean> {
  const viewingId = appStore.getState().view.viewingAgentId;
  if (viewingId === null) return false;
  const task = getBackgroundTask(viewingId);
  if (task === undefined) return false;

  const expanded = expandToContentBlocks(text, deps.pasteStoreRef.current);
  const input = {
    task,
    sessionId: deps.agent.deps.session.id,
    cwd: deps.agent.deps.session.cwd,
    text: expanded.text.length > 0 ? expanded.text : text,
    blocks: expanded.blocks,
  };

  // The resume router already lands every event on the task row (the same
  // coverage a directive-spawned background run gets), so no extra sink.
  const delivered =
    task.status === "running"
      ? await steerViewedAgent(input)
      : await resumeViewedAgent({ ...input, agent: deps.agent, eventSink: () => {} });
  if (!delivered) {
    deps.showUndeliverable(
      "This agent cannot receive messages (no resumable transcript); the message was not sent.",
    );
  }
  return true;
}
