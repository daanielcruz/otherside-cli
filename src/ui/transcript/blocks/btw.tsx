import { useEffect, useState } from "react";
import { Box, Text, useRepeatingClock } from "@/ink";
import { type BtwTurn, listBtwTurns, subscribeBtwTurns } from "@/store/btw-store/index.ts";
import { Color } from "@/ui/theme/theme.ts";

export interface BtwBlockProps {
  active: boolean;
  pendingFrame?: number;
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_TICK_MS = 90;
const MAX_VISIBLE_TURNS = 4;

export function BtwBlock({ active, pendingFrame = 0 }: BtwBlockProps): React.JSX.Element | null {
  const [turns, setTurns] = useState<BtwTurn[]>(() => listBtwTurns());
  const [frame, setFrame] = useState(pendingFrame);

  useEffect(() => {
    return subscribeBtwTurns(() => setTurns(listBtwTurns()));
  }, []);

  const lastTurn = turns.at(-1);
  const spinning = active && lastTurn?.status === "pending";
  useRepeatingClock(() => setFrame((f) => f + 1), spinning ? SPINNER_TICK_MS : null);

  if (!active && turns.length === 0) return null;

  const visible = turns.slice(-MAX_VISIBLE_TURNS);
  const elided = Math.max(0, turns.length - visible.length);

  return (
    <Box flexDirection="column" marginTop={1} paddingX={1}>
      <Box>
        <Text color={Color.steel} bold>
          /btw
        </Text>
        <Text color={Color.muted}> side question mode {active ? "" : "· closed"}</Text>
      </Box>
      {elided > 0 && (
        <Box>
          <Text color={Color.muted}>(+{elided} earlier)</Text>
        </Box>
      )}
      <Box flexDirection="column" marginTop={1}>
        {visible.map((turn) => (
          <BtwTurnView key={turn.id} turn={turn} frame={frame} />
        ))}
      </Box>
      {active && (
        <Box marginTop={1}>
          <Text color={Color.muted}>type to ask · Esc to exit</Text>
        </Box>
      )}
    </Box>
  );
}

function BtwTurnView({ turn, frame }: { turn: BtwTurn; frame: number }): React.JSX.Element {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text color={Color.steel}>❯ </Text>
        <Text color={Color.text}>{turn.question}</Text>
      </Box>
      <Box marginLeft={2}>
        <BtwTurnBody turn={turn} frame={frame} />
      </Box>
    </Box>
  );
}

function BtwTurnBody({ turn, frame }: { turn: BtwTurn; frame: number }): React.JSX.Element {
  if (turn.status === "pending") {
    const spinner = SPINNER_FRAMES[frame % SPINNER_FRAMES.length] ?? "·";
    return <Text color={Color.steel}>{spinner} Answering…</Text>;
  }
  if (turn.status === "error") {
    return <Text color={Color.warning}>{turn.error ?? "Failed to get response"}</Text>;
  }
  if (turn.status === "cancelled") {
    return <Text color={Color.muted}>(cancelled)</Text>;
  }
  if (turn.response === null || turn.response.length === 0) {
    return <Text color={Color.muted}>(empty response)</Text>;
  }
  if (turn.synthetic) {
    return (
      <Box flexDirection="column">
        <Text color={Color.text}>{turn.response}</Text>
        <Text color={Color.muted}>(synthetic — ask in main thread for an action)</Text>
      </Box>
    );
  }
  return <Text color={Color.text}>{turn.response}</Text>;
}
