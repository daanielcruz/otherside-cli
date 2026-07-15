import { Box, Text } from "@/ink";
import { withStableIds } from "@/kernel/std/keys.ts";
import { Color } from "@/ui/theme/theme.ts";

const MASCOT_RAW = `
                               +++++++++
                          +++++==-----=-==++++
                        +++-::---:::...:------++
                      ++=:--::.:..:::...:-:..--==+++
                     ++---::..:==++ ++*=:...:::..-==++ +++
                   ++=-=-:.-+            *=-..:--:::-=-+++
                 +++-==:.:+                #=:....:----=====+*##
                ++=-=-:.=+                  ##+-:..::.....:+==+*#
              +++-+=-:.=*                    ##*+-..:::...:-=-+*#
           +++====-:..=##                     #*:.......::-++*##
         +=---::....-+*##                   +*=..::..::=++*###
       +=--:::..:..:-+##               ++=-::...::--=+*####
      ++-=-:.....:...::=++*###**====--:...::---=+*####
      #*+=-==-..:::::::..........::..:-==++**#######
       ###***++==--=---------++******######  #+--++
          %%###***####***#########        ##*-.:++
               **##**+=:.:=*##          ##+-.:-++
                    +++-::...:=+******+-:..:-++
                       +++=::..........::-=++
                           +++---:----+++*
                                +++++
`;

function stripCommonLeadingSpaces(lines: string[]): string[] {
  const filtered = lines.filter((l) => l.length > 0);
  let min = Number.POSITIVE_INFINITY;
  for (const l of filtered) {
    if (l.trim().length === 0) continue;
    const indent = l.length - l.trimStart().length;
    if (indent < min) min = indent;
  }
  if (!Number.isFinite(min) || min <= 0) return filtered;
  return filtered.map((l) => l.slice(min));
}

export const MASCOT_LINES = stripCommonLeadingSpaces(MASCOT_RAW.split("\n"));
const MASCOT_ROWS = withStableIds(MASCOT_LINES);

export const TAGLINE = "past the event horizon · where even returns escape";

export interface MascotProps {
  variant?: "boot" | "compact";
}

export function Mascot({ variant = "boot" }: MascotProps): React.JSX.Element {
  if (variant === "compact") {
    return (
      <Box>
        <Text color={Color.text} bold>
          otherside
        </Text>
        <Text color={Color.muted}> · </Text>
        <Text color={Color.muted}>{TAGLINE}</Text>
      </Box>
    );
  }
  return (
    <Box flexDirection="column">
      {MASCOT_ROWS.map(({ id, line }) => (
        <Text key={id} color={Color.primary}>
          {line}
        </Text>
      ))}
    </Box>
  );
}
