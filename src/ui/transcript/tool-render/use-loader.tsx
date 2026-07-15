import { Box, Text, useFrameClock } from "@/ink";
import { Color, Glyph } from "@/ui/theme/theme.ts";

const BLACK_CIRCLE = Glyph.bullet;
const BLINK_INTERVAL_MS = 600;

export interface ToolUseLoaderProps {
  isError: boolean;
  isUnresolved: boolean;
  shouldAnimate: boolean;
}

function loaderColor(isUnresolved: boolean, isError: boolean) {
  if (isUnresolved) return Color.muted;
  if (isError) return Color.error;
  return Color.success;
}

export function ToolUseLoader({
  isError,
  isUnresolved,
  shouldAnimate,
}: ToolUseLoaderProps): React.JSX.Element {
  const [ref, time] = useFrameClock(shouldAnimate ? BLINK_INTERVAL_MS : null);
  const visible = Math.floor(time / BLINK_INTERVAL_MS) % 2 === 0;

  const color = loaderColor(isUnresolved, isError);
  const showCircle = !shouldAnimate || visible || isError || !isUnresolved;
  const glyph = showCircle ? BLACK_CIRCLE : " ";

  return (
    <Box ref={ref} minWidth={2}>
      <Text color={color} dim={isUnresolved}>
        {glyph}
      </Text>
    </Box>
  );
}
