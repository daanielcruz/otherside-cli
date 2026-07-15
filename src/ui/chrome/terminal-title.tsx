import { useState } from "react";
import { sanitizeTitle } from "@/engine/session/index.ts";
import { useRepeatingClock, useWindowCaption } from "@/ink";
import { useAppSelect } from "@/store";

export const DEFAULT_TERMINAL_TITLE = "Otherside CLI";
const PRODUCT_GLYPH = "¤";
const TITLE_ANIMATION_FRAMES = ["⠂", "⠐"] as const;
const TITLE_ANIMATION_INTERVAL_MS = 960;

const FALSY_ENV_VALUES = new Set(["", "0", "false", "no", "off", "n"]);

function titlesDisabled(): boolean {
  const raw = process.env.OTHERSIDE_DISABLE_TERMINAL_TITLE;
  return raw !== undefined && !FALSY_ENV_VALUES.has(raw.toLowerCase());
}

export interface TerminalTitleProps {
  title: string | null;
}

export function TerminalTitle({ title }: TerminalTitleProps): null {
  const busy = useAppSelect((s) => s.view.busy);
  const [frameIdx, setFrameIdx] = useState(0);

  useRepeatingClock(
    () => setFrameIdx((i) => (i + 1) % TITLE_ANIMATION_FRAMES.length),
    busy ? TITLE_ANIMATION_INTERVAL_MS : null,
  );

  const text = title !== null ? sanitizeTitle(title) : "";
  const resolved = text.length > 0 ? text : DEFAULT_TERMINAL_TITLE;
  const prefix = busy ? TITLE_ANIMATION_FRAMES[frameIdx] : PRODUCT_GLYPH;
  const activeTitle = titlesDisabled() ? null : `${prefix} ${resolved}`;

  useWindowCaption(activeTitle);

  return null;
}
