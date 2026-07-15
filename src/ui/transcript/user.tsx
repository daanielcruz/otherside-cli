import type { ContextUsageData } from "@/engine/session/usage/context.ts";
import { Box, Text } from "@/ink";
import { stringWidth as columnCount } from "@/kernel/std/text/string-width.ts";
import { wrapLine } from "@/kernel/std/text/wrapping.ts";
import { wrapPromptText } from "@/ui/input/prompt-text.ts";
import { Color, Glyph, GUTTER_CONT, GUTTER_HEAD } from "@/ui/theme/theme.ts";
import { ContextUsageRows } from "@/ui/transcript/context-usage.tsx";
import { osc8FileLink } from "@/ui/transcript/markdown/osc8.ts";
import type { TranscriptImage } from "@/ui/transcript/types";

export const USER_MESSAGE_MAX_CHARS = 10_000;
export const USER_MESSAGE_HEAD_CHARS = 2_500;
export const USER_MESSAGE_TAIL_CHARS = 2_500;

export function collapseLongUserMessage(text: string): string {
  if (text.length <= USER_MESSAGE_MAX_CHARS) return text;
  const head = text.slice(0, USER_MESSAGE_HEAD_CHARS);
  const tail = text.slice(-USER_MESSAGE_TAIL_CHARS);
  const newlinesAfterHead = countOccurrences(text, "\n", USER_MESSAGE_HEAD_CHARS);
  const newlinesInTail = countOccurrences(tail, "\n", 0);
  const hiddenLines = Math.max(0, newlinesAfterHead - newlinesInTail);
  return `${head}\n… +${hiddenLines} lines …\n${tail}`;
}

function countOccurrences(str: string, ch: string, start: number): number {
  let count = 0;
  let i = str.indexOf(ch, start);
  while (i !== -1) {
    count++;
    i = str.indexOf(ch, i + 1);
  }
  return count;
}

export function UserRow({
  text,
  anchor,
  width,
  images,
  contextUsage,
}: {
  text: string;
  anchor?: string | undefined;
  width: number;
  images?: TranscriptImage[] | undefined;
  contextUsage?: ContextUsageData | undefined;
}): React.JSX.Element {
  const displayText = collapseLongUserMessage(text);
  const lines = userMessageLines(displayText, width);
  const keyedLines = keyedUserLines(lines);
  const imageAnchorEntries = (images ?? []).map((image, index) => {
    const id = image.id ?? index + 1;
    return { id, localPath: image.localPath };
  });
  return (
    <Box flexDirection="column" marginTop={1}>
      {keyedLines.map(({ line, position, key }) => (
        <UserLine key={key} line={line} position={position} width={width} />
      ))}
      {imageAnchorEntries.length > 0 && (
        <ImageAnchorRows entries={imageAnchorEntries} width={width} />
      )}
      {!!contextUsage && <ContextUsageRows data={contextUsage} />}
      {!!anchor && !isUuid(anchor) && !contextUsage && <AnchorRows text={anchor} width={width} />}
    </Box>
  );
}

function ImageAnchorRows({
  entries,
  width,
}: {
  entries: { id: number; localPath: string | undefined }[];
  width: number;
}): React.JSX.Element {
  return (
    <Box flexDirection="column">
      {entries.map((entry, index) => {
        const label = `[Image #${entry.id}]`;
        const wrapped = entry.localPath ? osc8FileLink({ path: entry.localPath, label }) : label;
        const prefix = index === 0 ? GUTTER_HEAD : GUTTER_CONT;
        return (
          <Box key={`img-${entry.id}`} width={Math.max(1, width)}>
            <Text color={Color.muted}>{prefix}</Text>
            <Text color={Color.text}>{wrapped}</Text>
          </Box>
        );
      })}
    </Box>
  );
}

function UserLine({
  line,
  position,
  width,
}: {
  line: string;
  position: number;
  width: number;
}): React.JSX.Element {
  const prefix = position === 0 ? Glyph.chevron : "  ";
  const filler = " ".repeat(Math.max(0, width - columnCount(prefix) - columnCount(line)));
  return (
    <Box width={Math.max(1, width)}>
      <Text color={Color.badgePrefix} backgroundColor={Color.inverseBg}>
        {prefix}
      </Text>
      <Text color={Color.queueText} backgroundColor={Color.inverseBg}>
        {line}
      </Text>
      {filler.length > 0 && (
        <Text color={Color.queueText} backgroundColor={Color.inverseBg}>
          {filler}
        </Text>
      )}
    </Box>
  );
}

const USER_MESSAGE_PREFIX_WIDTH = 2;
const USER_MESSAGE_RIGHT_PADDING = 5;

export function userMessageLines(text: string, width: number): string[] {
  const inner = Math.max(1, width - USER_MESSAGE_PREFIX_WIDTH - USER_MESSAGE_RIGHT_PADDING);
  return wrapPromptText(text, inner, inner);
}

function keyedUserLines(lines: string[]): { line: string; position: number; key: string }[] {
  const seen = new Map<string, number>();
  const keyed: { line: string; position: number; key: string }[] = [];
  for (const line of lines) {
    const count = seen.get(line) ?? 0;
    seen.set(line, count + 1);
    keyed.push({ line, position: keyed.length, key: `${line}:${count}` });
  }
  return keyed;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(str: string): boolean {
  return UUID_RE.test(str);
}

function AnchorRows({ text, width }: { text: string; width: number }): React.JSX.Element {
  const contentWidth = Math.max(1, width - columnCount(GUTTER_HEAD));
  const lines = text.split("\n").flatMap((line) => wrapLine(line, { width: contentWidth }));
  const rendered = lines.length > 0 ? lines : [""];
  const keyedLines = keyedAnchorLines(rendered);
  return (
    <Box flexDirection="column">
      {keyedLines.map(({ line, position, key }) => (
        <Box key={key} width={Math.max(1, width)}>
          <Text color={Color.muted}>{position === 0 ? GUTTER_HEAD : GUTTER_CONT}</Text>
          <Text color={Color.muted}>{line}</Text>
        </Box>
      ))}
    </Box>
  );
}

function keyedAnchorLines(lines: string[]): { line: string; position: number; key: string }[] {
  const seen = new Map<string, number>();
  const keyed: { line: string; position: number; key: string }[] = [];
  for (const line of lines) {
    const count = seen.get(line) ?? 0;
    seen.set(line, count + 1);
    keyed.push({
      line,
      position: keyed.length,
      key: `anchor:${line}:${count}`,
    });
  }
  return keyed;
}
