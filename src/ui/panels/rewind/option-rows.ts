import { truncateEllipsis } from "@/kernel/std/text/text.ts";
import { renderTextWithStyles } from "@/terminal-runtime/text/color-codes.js";
import { Color, Glyph } from "@/ui/theme/theme.ts";
import type { RewindOption, RewindTurn } from "./options.ts";

/** The checkpoint list's row projection: marker, preview, files-changed metadata. */
export function renderRewindOptionLines(
  option: RewindOption,
  selected: boolean,
  width: number,
): string[] {
  const marker = renderTextWithStyles(selected ? Glyph.chevron : "  ", {
    color: selected ? Color.panelAccent : Color.muted,
    bold: selected,
  });
  if (option.kind === "current") {
    return [
      marker +
        renderTextWithStyles("(current)", {
          color: selected ? Color.panelAccent : Color.text,
          italic: true,
        }),
      "",
      "",
    ];
  }

  const label = truncateEllipsis(option.preview, Math.max(1, width - 10));
  return [
    marker +
      renderTextWithStyles(label, {
        color: selected ? Color.panelAccent : Color.text,
      }),
    "  " + renderFilesChangedMetadata(option, selected),
    "",
  ];
}

function renderFilesChangedMetadata(option: RewindTurn, selected: boolean): string {
  if (option.filesChanged === 0) {
    return renderTextWithStyles("No code changes", {
      color: Color.muted,
      dim: !selected,
    });
  }
  const subject =
    option.filesChanged === 1 && option.firstFileBasename
      ? option.firstFileBasename
      : `${option.filesChanged} files changed`;
  return (
    renderTextWithStyles(`${subject} `, { color: Color.muted, dim: !selected }) +
    renderTextWithStyles(`+${option.insertions}`, { color: Color.diffAddFg }) +
    " " +
    renderTextWithStyles(`-${option.deletions}`, { color: Color.diffRemFg })
  );
}
