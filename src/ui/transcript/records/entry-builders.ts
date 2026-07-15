import { stripCommandMarkup } from "@/engine/session/index.ts";
import type { SessionRecord } from "@/engine/session/record/index.ts";
import { stringifyForDisplay } from "@/kernel/std/text/json-display.ts";
import { pluralize } from "@/kernel/std/text/pluralize.ts";
import type { ToolResultMeta } from "@/kernel/std/types/message.ts";
import { Glyph } from "@/ui/theme/theme.ts";
import type { TranscriptEntry, TranscriptImage } from "@/ui/transcript/types.ts";

export {
  formatToolInput,
  taskNotificationFromAttachment,
} from "@/engine/session/transcript/record-format.ts";

export function formatHookEventForReplay(record: {
  kind: string;
  payload: unknown;
}): string | null {
  const payload =
    record.payload && typeof record.payload === "object"
      ? (record.payload as Record<string, unknown>)
      : {};
  if (record.kind === "goal_met") {
    const condition = typeof payload.condition === "string" ? payload.condition : "";
    return `${Glyph.check} Goal achieved${condition ? ` — ${condition}` : ""}`;
  }
  if (record.kind === "goal_not_met") {
    const reason = typeof payload.reason === "string" ? payload.reason : "";
    return `${Glyph.bulletHollow} Goal not yet met${reason ? ` — ${reason}` : ""}`;
  }
  if (record.kind === "goal_paused_bg") {
    const n =
      typeof payload.runningBackgroundTasks === "number" ? payload.runningBackgroundTasks : 0;
    return `${Glyph.bullseye} Goal paused — waiting on ${n} background ${pluralize(n, "task")}`;
  }
  return null;
}

export function transcriptImagesFromRecord(
  record: Extract<SessionRecord, { type: "user_message" }>,
): TranscriptImage[] {
  if (Array.isArray(record.pastedImages) && record.pastedImages.length > 0) {
    return record.pastedImages.map((img) => ({
      id: img.id,
      mediaType: img.mediaType,
    }));
  }
  const blocks = Array.isArray(record.inlineImages) ? record.inlineImages : [];
  return blocks.flatMap((block, index) => {
    if (block.type !== "image") return [];
    const id = record.imagePasteIds?.[index];
    return id === undefined
      ? [{ mediaType: block.source.media_type }]
      : [{ id, mediaType: block.source.media_type }];
  });
}

function decodeTaskNoticeXml(value: string | undefined): string | undefined {
  return value
    ?.replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

export function taskNoticeTextFromNotification(content: string): string {
  const summary = decodeTaskNoticeXml(content.match(/<summary>([\s\S]*?)<\/summary>/)?.[1]?.trim());
  return summary && summary.length > 0 ? summary : "Background task completed";
}

const CONTROL_PLANE_BLOCKS = [
  /<system-reminder>[\s\S]*?<\/system-reminder>/gi,
  /<task-notification>[\s\S]*?<\/task-notification>/gi,
];

export function stripControlPlaneMarkup(text: string): string {
  let out = stripCommandMarkup(text) ?? "";
  for (const re of CONTROL_PLANE_BLOCKS) out = out.replace(re, "");
  return out.replace(/\n{3,}/g, "\n\n").trim();
}

function askAnswerEntryFromMeta(meta: ToolResultMeta, id: string): TranscriptEntry | null {
  if (meta.kind !== "ask") return null;
  if (meta.declined) {
    return {
      id,
      kind: "ask_answer",
      text: "User declined to answer questions",
      askPayload: { declined: true },
    };
  }
  if (meta.answers.length === 0) return null;
  return {
    id,
    kind: "ask_answer",
    text: "",
    askPayload: { declined: false, answers: meta.answers },
  };
}

function askAnswerEntryFromContent(content: string, id: string): TranscriptEntry | null {
  if (content.startsWith("The user cancelled") || content.startsWith("The user wants to clarify")) {
    return {
      id,
      kind: "ask_answer",
      text: "User declined to answer questions",
      askPayload: { declined: true },
    };
  }
  if (content.startsWith("User has answered your questions:")) {
    const raw = content.slice("User has answered your questions:".length).trim();
    const dotIndex = raw.lastIndexOf('". ');
    const qaPart = dotIndex >= 0 ? raw.slice(0, dotIndex + 1) : raw;
    const pairs = qaPart.split(/,\s*(?=")/).map((segment) => {
      const match = segment.trim().match(/^"(.+?)"="(.+?)"$/);
      if (!match) return null;
      return { question: match[1] ?? "", answer: match[2] ?? "" };
    });
    const answers = pairs.filter((p): p is { question: string; answer: string } => p !== null);
    if (answers.length === 0) return null;
    return {
      id,
      kind: "ask_answer",
      text: "",
      askPayload: { declined: false, answers },
    };
  }
  return null;
}

export function askAnswerEntry(
  content: string,
  id: string,
  meta?: ToolResultMeta,
): TranscriptEntry | null {
  if (meta) {
    const fromMeta = askAnswerEntryFromMeta(meta, id);
    if (fromMeta) return fromMeta;
  }
  return askAnswerEntryFromContent(content, id);
}

export function resultToText(result: unknown): string {
  return stringifyForDisplay(result);
}

export function augmentAgentResult(resultText: string, args: unknown): string {
  const trimmed = resultText.trim();
  if (!trimmed.startsWith("{")) return resultText;
  let parsed: unknown;
  try {
    parsed = JSON.parse(resultText);
  } catch {
    return resultText;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return resultText;
  const obj = parsed as Record<string, unknown>;
  if (!args || typeof args !== "object") return resultText;
  const argObj = args as Record<string, unknown>;
  if (typeof argObj.subagent_type === "string" && obj.subagent_type === undefined) {
    obj.subagent_type = argObj.subagent_type;
  }
  if (typeof argObj.description === "string" && obj.description === undefined) {
    obj.description = argObj.description;
  }
  return JSON.stringify(obj);
}

export function producesUserTranscriptEntry(record: SessionRecord): boolean {
  if (record.type !== "user_message") return false;
  if ("isSidechain" in record && record.isSidechain) return false;
  if (record.content.trim().length > 0) return true;
  return transcriptImagesFromRecord(record).length > 0;
}

export function findRewindCutIndex(
  records: SessionRecord[],
  selectedAnchor: string | undefined,
  userDroppedCount: number,
): number {
  if (typeof selectedAnchor === "string") {
    const byUuid = records.findIndex((r) => r.type === "user_message" && r.uuid === selectedAnchor);
    if (byUuid >= 0) return byUuid;
  }
  if (userDroppedCount <= 0) return records.length;
  let seen = 0;
  for (let i = records.length - 1; i >= 0; i -= 1) {
    const record = records[i];
    if (!record || !producesUserTranscriptEntry(record)) continue;
    seen += 1;
    if (seen === userDroppedCount) return i;
  }
  return records.length;
}
