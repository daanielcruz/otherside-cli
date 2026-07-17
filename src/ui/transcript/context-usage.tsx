import type { ContextUsageCategory, ContextUsageData } from "@/engine/session/usage/context.ts";
import { Box, type Color as InkColor, Text } from "@/ink";
import { Color, GUTTER_HEAD, type SolidColorKey } from "@/ui/theme/theme.ts";
import { thousandsValue } from "@/ui/transcript/message-shared.ts";

const CTX_GRID_COLS = 20;
const CTX_GRID_ROWS = 10;
const CTX_GRID_CELLS = CTX_GRID_COLS * CTX_GRID_ROWS;
const CTX_FILL_GLYPH = "⛁";
const CTX_EMPTY_GLYPH = "⛶";

function formatCtxTokens(n: number): string {
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    return Number.isInteger(m) ? `${m}m` : `${m.toFixed(1)}m`;
  }
  if (n >= 1000) {
    const k = n / 1000;
    return `${thousandsValue(k)}k`;
  }
  return `${n}`;
}

function resolveCtxColor(value: SolidColorKey): InkColor {
  return Color[value];
}

function isFreeSpaceCategory(cat: ContextUsageCategory): boolean {
  return cat.name.toLowerCase() === "free space";
}

export function ContextUsageRows({ data }: { data: ContextUsageData }): React.JSX.Element {
  const total = Math.max(1, data.windowTokens || data.totalTokens || 1);
  const fillCats = data.categories.filter((c) => !isFreeSpaceCategory(c));
  const cells: { count: number; color: InkColor }[] = fillCats.map((cat) => {
    const raw = (Math.max(0, cat.tokens) / total) * CTX_GRID_CELLS;
    const count = cat.tokens > 0 ? Math.max(1, Math.floor(raw)) : 0;
    return { count, color: resolveCtxColor(cat.color) };
  });
  let assigned = cells.reduce((s, c) => s + c.count, 0);
  if (assigned > CTX_GRID_CELLS) {
    let overflow = assigned - CTX_GRID_CELLS;
    for (let i = cells.length - 1; i >= 0 && overflow > 0; i--) {
      const cell = cells[i];
      if (!cell) continue;
      const take = Math.min(cell.count, overflow);
      cell.count -= take;
      overflow -= take;
    }
    assigned = CTX_GRID_CELLS;
  }
  const flat: { color: InkColor | null }[] = [];
  for (const c of cells) {
    for (let i = 0; i < c.count; i++) flat.push({ color: c.color });
  }
  while (flat.length < CTX_GRID_CELLS) flat.push({ color: null });

  const pct =
    data.windowTokens > 0
      ? Math.min(100, Math.round((data.totalTokens / data.windowTokens) * 100))
      : 0;
  const tokenLine =
    data.windowTokens > 0
      ? `${formatCtxTokens(data.totalTokens)}/${formatCtxTokens(data.windowTokens)} tokens (${pct}%)`
      : `${formatCtxTokens(data.totalTokens)} tokens`;

  const headerRows: React.JSX.Element[] = [
    <Text key="ctx-h1" color={Color.text}>
      {data.modelLabel}
    </Text>,
    <Text key="ctx-h2" color={Color.muted}>
      {data.modelId}
    </Text>,
    <Text key="ctx-h3" color={Color.muted}>
      {tokenLine}
    </Text>,
    <Text key="ctx-h4" color={Color.muted}>
      {" "}
    </Text>,
    <Text key="ctx-h5" color={Color.muted} italic>
      Estimated usage by category
    </Text>,
  ];
  const catRows = data.categories.map((cat) => {
    const cw = data.windowTokens > 0 ? (cat.tokens / data.windowTokens) * 100 : 0;
    const color = resolveCtxColor(cat.color);
    const isFree = isFreeSpaceCategory(cat);
    const glyph = isFree || cat.tokens === 0 ? CTX_EMPTY_GLYPH : CTX_FILL_GLYPH;
    return (
      <Box key={`ctx-cat-${cat.name}`}>
        <Text color={color}>{glyph} </Text>
        <Text color={Color.text}>{cat.name}: </Text>
        <Text color={Color.muted}>
          {formatCtxTokens(cat.tokens)} tokens ({cw.toFixed(1)}%)
          {cat.detail ? ` · ${cat.detail}` : ""}
        </Text>
      </Box>
    );
  });
  const rightColumn: React.JSX.Element[] = [...headerRows, ...catRows];

  const gridRows: React.JSX.Element[] = [];
  for (let r = 0; r < CTX_GRID_ROWS; r++) {
    const cellsRow: React.JSX.Element[] = [];
    for (let c = 0; c < CTX_GRID_COLS; c++) {
      const idx = r * CTX_GRID_COLS + c;
      const cell = flat[idx];
      const color = cell?.color;
      const glyph = color ? CTX_FILL_GLYPH : CTX_EMPTY_GLYPH;
      cellsRow.push(
        <Text key={`ctx-cell-${r}-${c}`} color={color ?? Color.subtle}>
          {c === 0 ? glyph : ` ${glyph}`}
        </Text>,
      );
    }
    gridRows.push(<Box key={`ctx-row-${r}`}>{cellsRow}</Box>);
  }

  return (
    <Box flexDirection="column" marginTop={0}>
      <Box>
        <Text color={Color.muted}>{GUTTER_HEAD}</Text>
        <Text color={Color.text} bold>
          Context Usage
        </Text>
      </Box>
      <Box marginLeft={4} flexDirection="row">
        <Box flexDirection="column" marginRight={2}>
          {gridRows}
        </Box>
        <Box flexDirection="column">{rightColumn}</Box>
      </Box>
    </Box>
  );
}
