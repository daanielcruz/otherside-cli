import { stringWidth } from "@/kernel/std/text/string-width.ts";
import { Glyph } from "@/ui/theme/theme.ts";

const PREFIX_GUTTER_WIDTH = 2;
const BULLET_TRAILING_SPACE = 1;

export const MAX_STATUS_LABEL_WIDTH = 28;
export const MIN_STATUS_LABEL_WIDTH = 4;

export function statusLabelPadding(): number {
  return (
    PREFIX_GUTTER_WIDTH +
    Math.max(stringWidth(Glyph.bulletFilled), stringWidth(Glyph.circleLarge)) +
    BULLET_TRAILING_SPACE
  );
}
