import { useEffect, useState } from "react";
import type { BackgroundTask } from "@/engine/background/tasks/background.ts";
import { subscribe as subscribeBackgroundTasks } from "@/engine/background/tasks/background.ts";
import { Box, Text } from "@/ink";
import { Color, Glyph } from "@/ui/theme/theme.ts";
import { Markdown } from "../markdown/index.tsx";

export interface BgTaskLogProps {
  task: BackgroundTask;
}

export function BgTaskLog({ task }: BgTaskLogProps): React.JSX.Element {
  useSubscriberRerender(task.status === "running");
  const prompt = task.prompt ?? "";
  return (
    <Box flexDirection="column" paddingX={1}>
      {prompt.length > 0 && (
        <Box marginTop={1} flexDirection="row">
          <Text color={Color.user}>{Glyph.chevron}</Text>
          <Box flexDirection="column" flexGrow={1}>
            <Text color={Color.user}>{prompt}</Text>
          </Box>
        </Box>
      )}
      {task.assistantText.length > 0 && (
        <Box marginTop={1} flexDirection="row">
          <Text color={Color.assistant}>{`${Glyph.bullet} `}</Text>
          <Box flexDirection="column" flexGrow={1}>
            <Markdown source={task.assistantText} />
          </Box>
        </Box>
      )}
      {task.kind === "shell" && task.shellOutput.length > 0 && (
        <Box marginTop={1} flexDirection="row">
          <Text color={Color.muted}>{`${Glyph.bullet} `}</Text>
          <Box flexDirection="column" flexGrow={1}>
            <Text color={Color.text}>{trimLongOutput(task.shellOutput)}</Text>
          </Box>
        </Box>
      )}
      {task.actions.map((action) => (
        <Box key={action.id} marginTop={1} flexDirection="row">
          <Text color={action.running ? Color.primaryGlow : Color.muted}>{`${Glyph.bullet} `}</Text>
          <Box flexDirection="column" flexGrow={1}>
            <Text>
              <Text color={Color.titleStrong} bold={action.running}>
                {action.toolName}
              </Text>
              {!!action.argsLabel && <Text color={Color.toolBody}>{`(${action.argsLabel})`}</Text>}
            </Text>
          </Box>
        </Box>
      ))}
      {!!task.result && (
        <Box marginTop={1} flexDirection="row">
          <Text color={task.result.isError ? Color.error : Color.muted}>{`${Glyph.bullet} `}</Text>
          <Box flexDirection="column" flexGrow={1}>
            <Text color={task.result.isError ? Color.error : Color.text}>
              {trimResult(task.result.content)}
            </Text>
          </Box>
        </Box>
      )}
    </Box>
  );
}

function trimResult(s: string): string {
  return s.length > 4000 ? `${s.slice(0, 3997)}…` : s;
}

function trimLongOutput(s: string): string {
  const MAX = 12_000;
  if (s.length <= MAX) return s;
  const tail = s.slice(s.length - MAX);
  return `[...${s.length - MAX} chars trimmed...]\n${tail}`;
}

function useSubscriberRerender(active: boolean): void {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!active) return;
    return subscribeBackgroundTasks(() => setTick((n) => n + 1));
  }, [active]);
}
