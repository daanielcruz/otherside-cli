import { getTranscriptEntries } from "@/store/transcript/index.ts";
import { stringWidth } from "@/terminal-runtime/text/cell-width.js";
import { renderTextWithStyles } from "@/terminal-runtime/text/color-codes.js";
import { Color } from "@/ui/theme/theme.ts";

const MASCOT_RAW = `
                           ..-=-===--:.
                      .:-++**oO*****o**o+=-:.
                    :+o**OOOOOOO#####O*OOO*o+=:
                  .=*O*O#O%%%%##**#%@%##OO#OOOo+-:.
                .=o****%%%O*=:..  ..-+O%%%####%#Oo+:.
               :+**o*#%O=.             :+O%%%O*O#O*oo+---..
             :=**ooO@#-                  .+*%%%%#O*OOO****o+=::.
           .-o**oo#%*:                     :=+*#@%##%%%%#%Oooo+=:.
          .+o++o*%%o:                       .:-+O@@#O##@@##o+*+=:.
       .::-=+o*#%#+:.                        :=O%@%%%%@%##*++=-.
   .:=++o*O#%%%#o=:.                       .=o#@%%%%##Oo++=-:.
 .=oOOOO#%@%%@%Oo-:                   .:-o*#%@###O*o+=-::.
.+*ooO#%@%%%%%%%%O*=..       .:---=oo#%@%%##**o+=--:..
:=+ooo**#%%%%%%%%%@@###*****####@@%%#O**o+==-:::.:.
 .:--=+==+o*O##O##OOOOO#%#O*oo++o=---:::.. .:-++=-
    ...::-------------:::.:......         .-*%O+:
         .::::::---=+=-:               .-+O%%O+.
          ...:::-+*#%@%#*+=:.      .:-+*#%#O+:
                  :-o*O%%@@%#OO**OO#%%%%Oo=:
                    .:-=+*O###%%%##O*o=-.
                         .:-==++=-::..
`;

const TAGLINE = "past the event horizon · where even returns escape";

function stripCommonLeadingSpaces(lines: string[]): string[] {
  const filtered = lines.filter((line) => line.length > 0);
  let min = Number.POSITIVE_INFINITY;
  for (const line of filtered) {
    if (line.trim().length === 0) continue;
    const indent = line.length - line.trimStart().length;
    if (indent < min) min = indent;
  }
  if (!Number.isFinite(min) || min <= 0) return filtered;
  return filtered.map((line) => line.slice(min));
}

const MASCOT_LINES = stripCommonLeadingSpaces(MASCOT_RAW.split("\n"));
const MASCOT_WIDTH = MASCOT_LINES.reduce((max, line) => Math.max(max, stringWidth(line)), 0);

/** Left pad so a `plainWidth`-wide payload sits centered in `width` columns. */
function centered(styled: string, plainWidth: number, width: number): string {
  const pad = Math.max(0, Math.floor((width - plainWidth) / 2));
  return " ".repeat(pad) + styled;
}

/** The boot banner rows: the mascot, the client name + version, and the tagline,
 * centered for `width`. Narrow terminals drop the mascot art and keep the name +
 * tagline. */
export function renderWelcomeBanner(version: string, width: number): string[] {
  const lines: string[] = [];
  if (width >= MASCOT_WIDTH) {
    // Block-center: one shared left pad for every row. Centering each row by its
    // own width would shift rows unequally and shear the art out of alignment.
    const blockPad = " ".repeat(Math.max(0, Math.floor((width - MASCOT_WIDTH) / 2)));
    for (const line of MASCOT_LINES) {
      lines.push(blockPad + renderTextWithStyles(line, { color: Color.primary }));
    }
    lines.push("");
  }
  const title = "otherside cli";
  const versionLabel = `v${version}`;
  const titleLine =
    renderTextWithStyles(title, { color: Color.text, bold: true }) +
    " " +
    renderTextWithStyles(versionLabel, { color: Color.subtle });
  lines.push(centered(titleLine, stringWidth(title) + 1 + stringWidth(versionLabel), width));
  lines.push("");
  lines.push(
    centered(
      renderTextWithStyles(TAGLINE, { color: Color.muted, italic: true }),
      stringWidth(TAGLINE),
      width,
    ),
  );
  lines.push("");
  return lines;
}

/**
 * Builds the host's static prelude for the boot banner. The host writes it once into
 * scrollback above the live frame, so the banner scrolls into history as the first
 * turn appends — the live frame stays short and the footer keeps its bottom margin,
 * instead of the banner occupying the live frame every turn and pushing the footer off
 * the viewport. A resumed session (transcript seeded non-empty) yields no prelude.
 * Visibility is captured once, after the boot transcript is seeded, so it stays fixed
 * across resizes (when the host re-emits the prelude).
 */
export function createWelcomePrelude(version: string): (width: number) => string[] {
  const startedEmpty = getTranscriptEntries().length === 0;
  return (width: number): string[] =>
    startedEmpty ? renderWelcomeBanner(version, Math.max(1, Math.floor(width))) : [];
}
