import * as tasks from "@/engine/background/tasks/index.ts";
import type { ContentBlock, Message } from "@/kernel/std/types/message.ts";

const TURNS_SINCE_WRITE = 10;
const TURNS_BETWEEN_REMINDERS = 10;

const TASK_CREATE_TOOL_NAME = "TaskCreate";
const TASK_UPDATE_TOOL_NAME = "TaskUpdate";

const TASK_REMINDER_BODY_HEAD = `The task tools haven't been used recently. If you're working on tasks that would benefit from tracking progress, consider using ${TASK_CREATE_TOOL_NAME} to add new tasks and ${TASK_UPDATE_TOOL_NAME} to update task status (set to in_progress when starting, completed when done). Also consider cleaning up the task list if it has become stale. Only use these if relevant to the current work. This is just a gentle reminder - ignore if not applicable. Make sure that you NEVER mention this reminder to the user\n`;

const TASK_REMINDER_MARKER = "task_reminder";

type TaskReminderBlock = Extract<ContentBlock, { type: "text" }> & {
  reminder_type: typeof TASK_REMINDER_MARKER;
};

interface TaskReminderArgs {
  messages: Message[];
  scope: string | undefined;
  effectiveTools: readonly { name: string }[];
}

interface TurnCounts {
  turnsSinceLastTaskManagement: number;
  turnsSinceLastReminder: number;
}

function isThinkingOnly(content: ContentBlock[]): boolean {
  if (content.length === 0) return false;
  return content.every((block) => block.type === "thinking");
}

function usesTaskManagement(content: ContentBlock[]): boolean {
  return content.some(
    (block) =>
      block.type === "tool_use" &&
      (block.name === TASK_CREATE_TOOL_NAME || block.name === TASK_UPDATE_TOOL_NAME),
  );
}

function isTaskReminderContent(content: ContentBlock[]): boolean {
  return content.some(
    (block) =>
      block.type === "text" &&
      (block as Partial<TaskReminderBlock>).reminder_type === TASK_REMINDER_MARKER,
  );
}

// Walk history backwards to count non-thinking assistant turns since the last TaskCreate/TaskUpdate use and since the last persisted task reminder. Both events are read directly from conversation history, so no cross-turn ephemeral state is required.
function countTurns(messages: Message[]): TurnCounts {
  let turnsSinceLastTaskManagement = 0;
  let turnsSinceLastReminder = 0;
  let foundTaskManagement = false;
  let foundReminder = false;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!message) continue;
    if (message.role === "assistant") {
      if (isThinkingOnly(message.content)) continue;
      if (!foundTaskManagement && usesTaskManagement(message.content)) {
        foundTaskManagement = true;
      }
      if (!foundTaskManagement) turnsSinceLastTaskManagement += 1;
      if (!foundReminder) turnsSinceLastReminder += 1;
    } else if (
      message.role === "user" &&
      !foundReminder &&
      isTaskReminderContent(message.content)
    ) {
      foundReminder = true;
    }
    if (foundTaskManagement && foundReminder) break;
  }
  return { turnsSinceLastTaskManagement, turnsSinceLastReminder };
}

function taskUpdateAvailable(effectiveTools: readonly { name: string }[]): boolean {
  return effectiveTools.some((tool) => tool.name === TASK_UPDATE_TOOL_NAME);
}

function buildBody(scope: string | undefined): string {
  const records = tasks.list(scope);
  const taskItems = records
    .map((task) => `#${task.id}. [${task.status}] ${task.subject}`)
    .join("\n");
  if (taskItems.length === 0) return TASK_REMINDER_BODY_HEAD;
  return `${TASK_REMINDER_BODY_HEAD}\n\nHere are the existing tasks:\n\n${taskItems}`;
}

export function buildTaskReminderInjection(args: TaskReminderArgs): string | null {
  const { messages, scope, effectiveTools } = args;
  if (!taskUpdateAvailable(effectiveTools)) return null;
  if (messages.length === 0) return null;

  const { turnsSinceLastTaskManagement, turnsSinceLastReminder } = countTurns(messages);
  if (turnsSinceLastTaskManagement < TURNS_SINCE_WRITE) return null;
  if (turnsSinceLastReminder < TURNS_BETWEEN_REMINDERS) return null;

  return `<system-reminder>\n${buildBody(scope)}\n</system-reminder>`;
}

// Persist the reminder into live conversation history so it survives to the next turn. Appending to the trailing user message keeps history free of consecutive user turns and places the reminder as that user turn's final block.
export function appendTaskReminderMessage(messages: Message[], reminder: string): void {
  const block: TaskReminderBlock = {
    type: "text",
    text: reminder,
    reminder_type: TASK_REMINDER_MARKER,
  };
  const last = messages[messages.length - 1];
  if (last && last.role === "user") {
    last.content = [...last.content, block];
    return;
  }
  messages.push({ role: "user", content: [block] });
}
