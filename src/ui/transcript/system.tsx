import { useState } from "react";
import { INTERRUPTED_FEEDBACK } from "@/engine/queue/runtime/interruption-text.ts";
import { Box, Text } from "@/ink";
import { Color, Glyph, GUTTER_CONT, GUTTER_HEAD } from "@/ui/theme/theme.ts";
import { colorFor, prefixFor, useSharedIntervalTick } from "@/ui/transcript/message-shared.ts";
import type { AskAnswerPayload, TranscriptEntry } from "@/ui/transcript/types";
import {
  isRetryCountdownSettled,
  RATE_LIMIT_PATTERN,
  retryCountdownDeadline,
} from "./stream/retry.ts";

function entryBodyColor(isError: boolean, muted: boolean): (typeof Color)[keyof typeof Color] {
  if (isError) return Color.error;
  if (muted) return Color.muted;
  return Color.text;
}

export function SystemRow({ entry }: { entry: TranscriptEntry }): React.JSX.Element {
  const prefix = entry.isError ? `${Glyph.bullet} ` : prefixFor(entry.kind);
  const prefixColor = entry.isError ? Color.error : colorFor(entry.kind);
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box flexDirection="row">
        <Text color={prefixColor}>{prefix}</Text>
        <Box flexDirection="column" flexGrow={1}>
          <Text color={entryBodyColor(entry.isError === true, entry.muted === true)}>
            {entry.text}
          </Text>
        </Box>
      </Box>
    </Box>
  );
}

const RETRY_TICK_MS = 500;

export function RetryRow({
  text,
  input,
}: {
  text: string;
  input?: string | undefined;
}): React.JSX.Element {
  let attempt = 0;
  let maxAttempts = 0;
  let initialSeconds = 0;
  let startedAt = 0;
  if (input) {
    try {
      const parsed = JSON.parse(input);
      if (typeof parsed === "object" && parsed !== null) {
        const obj = parsed as Record<string, unknown>;
        if (typeof obj.attempt === "number") attempt = obj.attempt;
        if (typeof obj.maxAttempts === "number") maxAttempts = obj.maxAttempts;
        if (typeof obj.seconds === "number") initialSeconds = obj.seconds;
        if (typeof obj.startedAt === "number") startedAt = obj.startedAt;
      }
    } catch {}
  }
  const [now, setNow] = useState(() => Date.now());
  const deadline = retryCountdownDeadline(startedAt, initialSeconds);
  const counting = deadline !== null && !isRetryCountdownSettled(deadline, now);
  useSharedIntervalTick(() => setNow(Date.now()), counting ? RETRY_TICK_MS : null);
  const elapsedSec = startedAt > 0 ? Math.floor((now - startedAt) / 1000) : 0;
  const remainingSec = startedAt > 0 ? Math.max(0, initialSeconds - elapsedSec) : initialSeconds;
  const isRateLimit = RATE_LIMIT_PATTERN.test(text);
  const headline = isRateLimit ? "Rate limited" : text.slice(0, 200);
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box flexDirection="row">
        <Text color={Color.error}>{GUTTER_HEAD}</Text>
        <Text color={Color.error}>{headline}</Text>
      </Box>
      <Box flexDirection="row">
        <Text color={Color.muted}>{GUTTER_CONT}</Text>
        <Text color={Color.muted} dim>
          {remainingSec > 0
            ? `Retrying in ${remainingSec}s · attempt ${attempt}/${maxAttempts}`
            : `Retrying · attempt ${attempt}/${maxAttempts}`}
        </Text>
      </Box>
    </Box>
  );
}

export function InterruptionRow(): React.JSX.Element {
  return (
    <Box>
      <Text color={Color.muted} dim>
        {`${GUTTER_HEAD}${INTERRUPTED_FEEDBACK}`}
      </Text>
    </Box>
  );
}

export function QuotaGutterRow({ text }: { text: string }): React.JSX.Element {
  return (
    <Box flexDirection="row">
      <Text color={Color.error}>{GUTTER_HEAD}</Text>
      <Text color={Color.error}>{text}</Text>
    </Box>
  );
}

export function ApiErrorRow({ text }: { text: string }): React.JSX.Element {
  return (
    <Box flexDirection="row" marginTop={1}>
      <Text color={Color.error}>{"  !  "}</Text>
      <Box flexDirection="column" flexGrow={1}>
        <Text color={Color.error}>{text}</Text>
      </Box>
    </Box>
  );
}

export function SlashErrorRow({ text }: { text: string }): React.JSX.Element {
  return (
    <Box flexDirection="row" marginTop={1}>
      <Box minWidth={2}>
        <Text color={Color.warning}>{Glyph.bullet} </Text>
      </Box>
      <Box flexDirection="column" flexGrow={1}>
        <Text color={Color.warning}>{text}</Text>
      </Box>
    </Box>
  );
}

export function CommandOutputRow({ text }: { text: string }): React.JSX.Element {
  return (
    <Box flexDirection="row">
      <Text color={Color.muted}>{GUTTER_HEAD}</Text>
      <Box flexDirection="column" flexGrow={1}>
        <Text color={Color.muted}>{text}</Text>
      </Box>
    </Box>
  );
}

export function AskAnswerRow({
  payload,
  text,
}: {
  payload?: AskAnswerPayload;
  text: string;
}): React.JSX.Element {
  if (!payload || payload.declined) {
    const label = payload ? "User declined to answer questions" : text;
    return (
      <Box flexDirection="row" marginTop={1}>
        <Text color={Color.text}>{Glyph.bullet} </Text>
        <Text color={Color.text}>{label}</Text>
      </Box>
    );
  }
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box flexDirection="row">
        <Text color={Color.text}>{Glyph.bullet} </Text>
        <Text color={Color.text}>User answered Otherside&apos;s questions:</Text>
      </Box>
      <Box flexDirection="row" marginLeft={2}>
        <Text color={Color.muted}>{`${Glyph.boxSharpBottomLeft} `}</Text>
        <Box flexDirection="column">
          {payload.answers.map(({ question, answer }) => (
            <Text key={question} color={Color.muted}>
              {`· ${question} → ${answer}`}
            </Text>
          ))}
        </Box>
      </Box>
    </Box>
  );
}
