import { Box, Text } from "@/ink";
import { formatScrollWindowLabel, type ListWindow } from "@/kernel/std/list-window.ts";
import { stringWidth } from "@/kernel/std/text/string-width.ts";
import { panelDividerText } from "@/ui/chrome/panel.tsx";
import { Color, Glyph } from "@/ui/theme/theme.ts";
import { PHASE_ROW_WIDTH, phaseRowColor, phaseRowGlyph } from "./constants.ts";
import { truncateToWidth } from "./segments.tsx";

export function WorkflowHeader(props: {
  name: string;
  subtext: string;
  stats: string;
  width: number;
}): React.JSX.Element {
  const { name, subtext, stats, width } = props;
  return (
    <Box flexDirection="column">
      <Text color={Color.text} wrap="truncate-end">
        {panelDividerText(Math.max(1, width))}
      </Text>
      <Text bold color={Color.primaryGlow} wrap="truncate-end">
        {" "}
        {name}
      </Text>
      <Box width={width} overflow="hidden">
        <Box flexGrow={1} flexShrink={1} overflow="hidden">
          <Text dim wrap="truncate-end">
            {" "}
            {subtext}
          </Text>
        </Box>
        {!!stats && (
          <Box flexShrink={0}>
            <Text dim>{stats} </Text>
          </Box>
        )}
      </Box>
    </Box>
  );
}

export function PhaseRow(props: {
  index: number;
  title: string;
  done: number;
  total: number;
  status: "not-started" | "running" | "done" | "failed";
  selected: boolean;
}): React.JSX.Element {
  const { index, title, done, total, status, selected } = props;
  const isDone = status === "done";
  const isFailed = status === "failed";
  const terminal = isDone || isFailed;
  const pointer = selected ? Glyph.chevron.trimEnd() : " ";
  const glyph = phaseRowGlyph({ isDone, isFailed, index });
  const glyphColor = phaseRowColor({ selected, isDone, isFailed }) ?? Color.subtle;
  const prefixWidth = stringWidth(pointer) + 1 + stringWidth(glyph) + 1;
  const title2 = truncateToWidth({ text: title, max: Math.max(1, PHASE_ROW_WIDTH - prefixWidth) });
  const line = `${pointer} ${glyph} ${title2}`;
  const titlePad = Math.max(0, PHASE_ROW_WIDTH - stringWidth(line));
  const counts = total > 0 ? `${done}/${total}` : "";
  const titleColor = phaseRowColor({ selected, isDone, isFailed });
  const titleDim = !selected && !terminal;
  const pointerColor = selected ? { color: Color.primaryGlow } : {};
  const titleColorProp = titleColor ? { color: titleColor } : {};
  return (
    <Box>
      <Text wrap="truncate-end">
        <Text {...pointerColor}>{pointer}</Text> <Text color={glyphColor}>{glyph}</Text>{" "}
        <Text {...titleColorProp} dim={titleDim}>
          {title2}
        </Text>
        {" ".repeat(titlePad)}
      </Text>
      <Text wrap="truncate-end" {...titleColorProp} dim={titleDim}>
        {counts}
      </Text>
    </Box>
  );
}

export function PhaseScrollIndicator(props: { win: ListWindow; total: number }): React.JSX.Element {
  const { win, total } = props;
  return (
    <Text dim wrap="truncate-end">
      {`  ${formatScrollWindowLabel({ win, total })}`}
    </Text>
  );
}
