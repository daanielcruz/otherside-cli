import { Box, Text, useTerminalDimensions } from "@/ink";
import { stringWidth } from "@/kernel/std/text/string-width.ts";
import { wrapText } from "@/kernel/std/text/wrapping.ts";
import { Color, Glyph } from "@/ui/theme/theme.ts";

export interface QueuedPreviewMessage {
  id: string;
  text: string;
  expanded?: string;
}

export interface QueuePreviewProps {
  messages: readonly QueuedPreviewMessage[];
  active?: boolean;
  columns?: number;
}

const QUEUE_LEFT_INDENT = 2;
const QUEUE_INNER_PAD = 1;

export function QueuePreview({
  messages,
  active = true,
  columns: columnsProp,
}: QueuePreviewProps): React.JSX.Element | null {
  const { columns: windowColumns } = useTerminalDimensions();
  const columns = Math.max(1, columnsProp ?? windowColumns);
  if (!active || messages.length === 0) return null;
  return (
    <Box flexDirection="column">
      {messages.map((message) => (
        <QueueMessage
          key={message.id}
          id={message.id}
          text={message.expanded || message.text}
          columns={columns}
        />
      ))}
    </Box>
  );
}

function QueueMessage({
  id,
  text,
  columns,
}: {
  id: string;
  text: string;
  columns: number;
}): React.JSX.Element {
  const prefixWidth = stringWidth(Glyph.chevron);
  const boxWidth = Math.max(1, columns - QUEUE_LEFT_INDENT);
  const textBudget = Math.max(1, boxWidth - QUEUE_INNER_PAD - prefixWidth);
  const wrapped = wrapText(text, textBudget);
  return (
    <Box flexDirection="column">
      {wrapped.map((line, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: index is safe here as lines are static and don't reorder
        <QueueRow key={`${id}_${index}`} text={line} showPrefix={index === 0} width={boxWidth} />
      ))}
    </Box>
  );
}

export function queueRowParts(
  text: string,
  showPrefix: boolean,
  width: number,
): { prefix: string; filler: string } {
  const prefix = showPrefix ? Glyph.chevron : " ".repeat(stringWidth(Glyph.chevron));
  const fillerWidth = Math.max(
    0,
    width - stringWidth(prefix) - stringWidth(text) - QUEUE_INNER_PAD,
  );
  return { prefix, filler: " ".repeat(fillerWidth) };
}

function QueueRow({
  text,
  showPrefix,
  width,
}: {
  text: string;
  showPrefix: boolean;
  width: number;
}): React.JSX.Element {
  const { prefix, filler } = queueRowParts(text, showPrefix, width);
  return (
    <Box>
      <Text>{" ".repeat(QUEUE_LEFT_INDENT)}</Text>
      <Box width={width}>
        <Text color={Color.badgePrefix} backgroundColor={Color.inverseBg}>
          {prefix}
        </Text>
        <Text color={Color.queueText} backgroundColor={Color.inverseBg}>
          {text}
        </Text>
        <Text backgroundColor={Color.inverseBg}>{" ".repeat(QUEUE_INNER_PAD)}</Text>
        {filler.length > 0 && (
          <Text color={Color.queueText} backgroundColor={Color.inverseBg}>
            {filler}
          </Text>
        )}
      </Box>
    </Box>
  );
}
