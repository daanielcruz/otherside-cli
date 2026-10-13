import { renderTextWithStyles } from "@/terminal-runtime/text/color-codes.js";
import { Color } from "@/ui/theme/theme.ts";

/**
 * A one-line text field drawn with its caret as an inverse cell. Empty, the caret
 * sits on the placeholder's first character and the rest of the placeholder dims;
 * with text, the caret covers the character at `caret`, or a blank past the end.
 */
export function fieldWithCaret(draft: string, caret: number, placeholder: string): string {
  if (draft.length === 0) {
    return (
      renderTextWithStyles(placeholder.slice(0, 1), { inverse: true }) +
      renderTextWithStyles(placeholder.slice(1), { color: Color.muted })
    );
  }
  const position = Math.max(0, Math.min(caret, draft.length));
  const caretCharacter = draft[position] ?? " ";
  return (
    renderTextWithStyles(draft.slice(0, position), { color: Color.text }) +
    renderTextWithStyles(caretCharacter, { inverse: true }) +
    renderTextWithStyles(draft.slice(position + (position < draft.length ? 1 : 0)), {
      color: Color.text,
    })
  );
}
