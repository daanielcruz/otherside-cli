import { get as getAgentDef } from "@/engine/agents/registry.ts";
import type { Color as InkColor } from "@/ink";
import { Box, Text } from "@/ink";
import type { AgentEvent } from "@/kernel/std/types/events.ts";
import { Color, Glyph } from "@/ui/theme/theme.ts";
import { displayModelName, formatNumberCompact } from "./tool-render/index.tsx";

const BULLET = Glyph.bullet;

export type AgentChipKind = "completed" | "failed" | "backgrounded" | "running" | "stopped";
export type AgentChipTaskKind = "agent" | "shell";

export interface AgentChipDescriptor {
  id: string;
  kind: AgentChipKind;
  taskKind: AgentChipTaskKind;
  description: string;
  subagentType?: string;
  model?: string;
  producedModel?: string;
  toolUses?: number;
  tokens?: number;
  durationMs?: number;
  exitCode?: number;
  reason?: string;
}

export interface AgentChipProps {
  chip: AgentChipDescriptor;
}

export function AgentChip({ chip }: AgentChipProps): React.JSX.Element {
  const color = chipColor(chip.kind);
  const verb = chipVerb(chip.kind);
  const stats = chipStats(chip);
  const label = chip.taskKind === "shell" ? "Background command" : "Agent";
  const fallbackName = chip.subagentType
    ? (getAgentDef(chip.subagentType)?.name ?? chip.subagentType)
    : label;
  const desc = chip.description.length > 0 ? chip.description : fallbackName;

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text>
        <Text color={color} bold>
          {BULLET}{" "}
        </Text>
        <Text color={Color.text}>{label} </Text>
        <Text color={Color.muted}>"</Text>
        <Text color={Color.text}>{desc}</Text>
        <Text color={Color.muted}>"</Text>
        {chip.kind === "stopped" && <Text color={Color.muted}>{` #${chip.id}`}</Text>}
        {!!chip.model && chip.kind !== "completed" && (
          <Text color={Color.muted}>{` ${displayModelName(chip.model)}`}</Text>
        )}
        {!!chip.producedModel &&
          (chip.kind === "completed" || chip.producedModel !== chip.model) && (
            <Text color={Color.muted}>{` ${displayModelName(chip.producedModel)}`}</Text>
          )}
        <Text color={Color.text}>{` ${verb}`}</Text>
        {stats.length > 0 && <Text color={Color.muted}>{` ${stats}`}</Text>}
      </Text>
      {chip.kind === "failed" && !!chip.reason && (
        <Box marginLeft={2}>
          <Text color={Color.error}>{chip.reason}</Text>
        </Box>
      )}
    </Box>
  );
}

function chipColor(kind: AgentChipKind): InkColor {
  if (kind === "completed") return Color.success;
  if (kind === "failed") return Color.error;
  if (kind === "backgrounded") return Color.muted;
  if (kind === "stopped") return Color.modeAccept;
  return Color.highlight;
}

function chipVerb(kind: AgentChipKind): string {
  if (kind === "completed") return "completed";
  if (kind === "failed") return "failed";
  if (kind === "backgrounded") return "backgrounded";
  if (kind === "stopped") return "was stopped";
  return "running";
}

function chipStats(chip: AgentChipDescriptor): string {
  const parts: string[] = [];
  if (typeof chip.exitCode === "number") {
    parts.push(`exit code ${chip.exitCode}`);
  }
  if (typeof chip.toolUses === "number") {
    parts.push(`${chip.toolUses} tool use${chip.toolUses === 1 ? "" : "s"}`);
  }
  if (typeof chip.tokens === "number" && chip.tokens > 0) {
    parts.push(`${formatNumberCompact(chip.tokens)} tokens`);
  }
  if (typeof chip.durationMs === "number" && chip.durationMs > 0) {
    parts.push(formatDurationMs(chip.durationMs));
  }
  return parts.length === 0 ? "" : `(${parts.join(" · ")})`;
}

export function formatDurationMs(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}m ${s}s`;
}

function resolveChipKind(parsedStatus: string, isError: boolean): AgentChipKind {
  if (
    parsedStatus === "completed" ||
    parsedStatus === "backgrounded" ||
    parsedStatus === "failed" ||
    parsedStatus === "stopped"
  ) {
    return parsedStatus;
  }
  if (isError) return "failed";
  return "completed";
}

export function agentChipFromEvent(
  event: AgentEvent,
): { id: string; chip: AgentChipDescriptor } | null {
  if (event.kind !== "tool_dispatch_complete") return null;
  if (event.name !== "Agent" && event.name !== "Bash") return null;
  const taskKind: AgentChipTaskKind = event.name === "Bash" ? "shell" : "agent";
  const parsed = parseAgentResult(event.content);
  if (!parsed) return null;
  if (event.name === "Bash" && parsed.subagentType === undefined) return null;
  const status = resolveChipKind(parsed.status, event.isError);
  return {
    id: `${taskKind}_${event.id}`,
    chip: {
      id: event.id,
      kind: status,
      taskKind,
      description: parsed.description ?? "",
      ...(parsed.subagentType ? { subagentType: parsed.subagentType } : {}),
      ...(parsed.model ? { model: parsed.model } : {}),
      ...(parsed.toolUses !== undefined ? { toolUses: parsed.toolUses } : {}),
      ...(parsed.tokens !== undefined ? { tokens: parsed.tokens } : {}),
      ...(parsed.durationMs !== undefined ? { durationMs: parsed.durationMs } : {}),
      ...(parsed.exitCode !== undefined ? { exitCode: parsed.exitCode } : {}),
      ...(parsed.reason ? { reason: parsed.reason } : {}),
    },
  };
}

interface ParsedAgent {
  status: string;
  description?: string;
  subagentType?: string;
  model?: string;
  toolUses?: number;
  tokens?: number;
  durationMs?: number;
  exitCode?: number;
  reason?: string;
}

function parseAgentResult(content: string): ParsedAgent | null {
  const trimmed = content.trim();
  if (!trimmed.startsWith("{")) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const status = typeof obj.status === "string" ? obj.status : "unknown";
  return {
    status,
    ...(typeof obj.description === "string" ? { description: obj.description } : {}),
    ...(typeof obj.subagent_type === "string" ? { subagentType: obj.subagent_type } : {}),
    ...(typeof obj.resolvedModel === "string" ? { model: obj.resolvedModel } : {}),
    ...(typeof obj.totalToolUseCount === "number" ? { toolUses: obj.totalToolUseCount } : {}),
    ...(typeof obj.totalTokens === "number" ? { tokens: obj.totalTokens } : {}),
    ...(typeof obj.totalDurationMs === "number" ? { durationMs: obj.totalDurationMs } : {}),
    ...(typeof obj.exitCode === "number" ? { exitCode: obj.exitCode } : {}),
    ...(typeof obj.reason === "string" ? { reason: obj.reason } : {}),
  };
}
