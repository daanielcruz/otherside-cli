import type { SlashCommand } from "@/commands/index.ts";
import { Box, Text, useTerminalDimensions } from "@/ink";
import { truncateEllipsis } from "@/kernel/std/text/text.ts";
import { Color } from "@/ui/theme/theme.ts";

const MAX_POPUP_ROWS = 6;
const POPUP_VIEWPORT_MARGIN = 3;

export interface AutocompleteProps {
  options: SlashCommand[];
  selected: number;
  noMatchQuery?: string | undefined;
}

export function Autocomplete({
  options,
  selected,
  noMatchQuery,
}: AutocompleteProps): React.JSX.Element | null {
  const { columns, rows } = useTerminalDimensions();
  // Default TUI path: stay in-flow under the prompt (not a fullscreen float).
  // Reserve a stable viewport while open so filtering 20→1 does not shrink the
  // frame and bounce the prompt bar.
  const maxRows = Math.max(1, Math.min(MAX_POPUP_ROWS, rows - POPUP_VIEWPORT_MARGIN));
  if (options.length === 0) {
    if (noMatchQuery !== undefined) {
      return (
        <Box
          flexDirection="column"
          height={maxRows}
          flexShrink={0}
          overflow="hidden"
          paddingX={0}
          marginTop={0}
        >
          <Text color={Color.muted}>No commands match "/{noMatchQuery}"</Text>
        </Box>
      );
    }
    return null;
  }
  const width = columns;
  const nameWidth = Math.min(32, Math.max(16, Math.floor((width - 6) * 0.4)));
  const descriptionWidth = Math.max(12, width - nameWidth - 8);
  const start = selected < maxRows ? 0 : Math.min(selected - maxRows + 1, options.length - 1);
  const visible = options.slice(start, start + maxRows);
  return (
    <Box
      flexDirection="column"
      height={maxRows}
      flexShrink={0}
      overflow="hidden"
      paddingX={0}
      marginTop={0}
    >
      {visible.map((opt, i) => {
        const index = start + i;
        const isSelected = index === selected;
        return (
          <Box key={opt.name} height={1} flexShrink={0}>
            <Text color={isSelected ? Color.highlight : Color.muted} bold={isSelected}>
              {`/${opt.name}`.padEnd(nameWidth)}
            </Text>
            <Text color={isSelected ? Color.highlight : Color.muted}>
              {truncateEllipsis(opt.description, descriptionWidth)}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}
