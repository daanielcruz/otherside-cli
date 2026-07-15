import {
  buildAgentSummary,
  buildBashSummary,
  buildWorkflowSummary,
  type TaskNotificationStatus,
} from "@/engine/background/tasks/notification.ts";
import { Box, type Color as InkColor, Text } from "@/ink";
import { Color, Glyph } from "@/ui/theme/theme.ts";
import { formatDurationMs } from "../agent-bridge.tsx";

const BULLET = Glyph.bullet;

export interface TaskNoticeData {
  taskKind: "agent" | "shell" | "workflow";
  status: TaskNotificationStatus;
  description: string;
  durationMs: number;
  exitCode?: number;
  taskId?: string;
}

export interface TaskNoticeProps {
  notice: TaskNoticeData;
}

export function TaskNotice({ notice }: TaskNoticeProps): React.JSX.Element {
  const color = noticeColor(notice.status);
  const text = noticeText(notice);
  return (
    <Box marginTop={1}>
      <Text>
        <Text color={color} bold>
          {`${BULLET} `}
        </Text>
        <Text color={Color.text}>{text}</Text>
        {notice.status === "killed" && !!notice.taskId && (
          <Text color={Color.muted}>{` #${notice.taskId}`}</Text>
        )}
      </Text>
    </Box>
  );
}

function noticeColor(status: TaskNotificationStatus): InkColor {
  if (status === "completed") return Color.success;
  if (status === "failed") return Color.error;
  return Color.warning;
}

function noticeText(notice: TaskNoticeData): string {
  if (notice.taskKind === "shell") {
    return buildBashSummary(
      notice.description,
      notice.status,
      notice.exitCode !== undefined ? { exitCode: notice.exitCode } : {},
    );
  }
  const summary =
    notice.taskKind === "workflow"
      ? buildWorkflowSummary(notice.description, notice.status)
      : buildAgentSummary(notice.description, notice.status);
  return notice.durationMs > 0 ? `${summary} · ${formatDurationMs(notice.durationMs)}` : summary;
}

export function parseTaskNotice(text: string): TaskNoticeData | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const taskKind = parseTaskKind(obj.taskKind);
  const status = parseStatus(obj.status);
  const description = typeof obj.description === "string" ? obj.description : "";
  const durationMs = typeof obj.durationMs === "number" ? obj.durationMs : 0;
  const exitCode = typeof obj.exitCode === "number" ? obj.exitCode : undefined;
  const taskId = typeof obj.taskId === "string" ? obj.taskId : undefined;
  return {
    taskKind,
    status,
    description,
    durationMs,
    ...(exitCode !== undefined ? { exitCode } : {}),
    ...(taskId !== undefined ? { taskId } : {}),
  };
}

function parseTaskKind(value: unknown): TaskNoticeData["taskKind"] {
  if (value === "shell") return "shell";
  if (value === "workflow") return "workflow";
  return "agent";
}

function parseStatus(value: unknown): TaskNotificationStatus {
  if (value === "failed") return "failed";
  if (value === "killed") return "killed";
  return "completed";
}
