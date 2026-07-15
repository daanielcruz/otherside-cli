import { Box, Text } from "@/ink";
import { Color, TAGLINE } from "@/ui/theme/theme.ts";
import { Mascot } from "./mascot.tsx";

export interface WelcomeProps {
  version: string;
  hasTranscript?: boolean;
  greeting?: string | undefined;
}

export function Welcome({
  version,
  hasTranscript = false,
  greeting,
}: WelcomeProps): React.JSX.Element {
  return (
    <Box flexDirection="column" alignItems="center" marginBottom={hasTranscript ? 2 : 1}>
      <Mascot variant="boot" />
      <Box marginTop={1}>
        <Text color={Color.text} bold>
          otherside cli
        </Text>
        <Text> </Text>
        <Text color={Color.subtle}>v{version}</Text>
      </Box>
      <Box marginTop={1}>
        <Text color={Color.muted} italic>
          {TAGLINE}
        </Text>
      </Box>
      {!!greeting && (
        <Box marginTop={1}>
          <Text color={Color.primary} bold>
            {greeting}
          </Text>
        </Box>
      )}
    </Box>
  );
}
