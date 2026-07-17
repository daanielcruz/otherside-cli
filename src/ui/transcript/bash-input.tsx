// Transcript echo of a `!` bash-mode submission: the command line styled as
// its own input class (pink `! ` + white text on the bash input background),
// followed by the command output in the tool gutter, exactly like a Bash tool
// result.

import { Box, Text } from "@/ink";
import type { ToolResultMeta } from "@/kernel/std/types/message.ts";
import { Color } from "@/ui/theme/theme.ts";
import { payloadFromMeta } from "@/ui/transcript/tool-render/payload.ts";
import { renderPayload } from "@/ui/transcript/tool-render/payload-view.tsx";

export function BashInputRow({
  command,
  resultMeta,
  width,
}: {
  command: string;
  resultMeta: ToolResultMeta | undefined;
  width: number;
}): React.JSX.Element {
  const payload = resultMeta !== undefined ? payloadFromMeta(resultMeta) : null;
  const isError = resultMeta?.kind === "bash" && (resultMeta.exit_code ?? 0) !== 0;
  return (
    <Box flexDirection="column" marginTop={1} width="100%">
      <Box width="100%">
        <Text backgroundColor={Color.bashInputBg}>
          <Text color={Color.bashMode}>! </Text>
          <Text color={Color.titleStrong}>{command}</Text>
        </Text>
      </Box>
      {payload !== null && (
        <Box flexDirection="column" width="100%">
          {renderPayload(payload, false, width, isError)}
        </Box>
      )}
    </Box>
  );
}
