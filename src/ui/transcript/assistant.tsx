import { Box, Text } from "@/ink";
import { getDisplayPath } from "@/kernel/std/fs/paths.ts";
import { Color, Glyph, GUTTER_CONT, GUTTER_HEAD } from "@/ui/theme/theme.ts";
import { colorFor, prefixFor } from "@/ui/transcript/message-shared.ts";
import type { TranscriptEntry } from "@/ui/transcript/types";
import { Markdown, StreamingMarkdown } from "./markdown/index.tsx";
import { osc8FileLink } from "./markdown/osc8.ts";
import { displayModelName, supportsHyperlinks } from "./tool-render/index.tsx";

export function AssistantRow({
  entry,
  width,
}: {
  entry: TranscriptEntry;
  width: number;
}): React.JSX.Element {
  const prefix = prefixFor(entry.kind);
  const isContinuation = entry.continuation === true;
  const modelHint =
    entry.producedModel && !isContinuation ? displayModelName(entry.producedModel) : "";
  const innerWidth = Math.max(1, width - prefix.length - (modelHint ? modelHint.length + 1 : 0));
  return (
    <Box flexDirection="row" marginTop={1}>
      <Text color={colorFor(entry.kind)}>
        {isContinuation ? " ".repeat(prefix.length) : prefix}
      </Text>
      {!!modelHint && <Text color={Color.muted}>{`${modelHint} `}</Text>}
      <Box flexDirection="column" width={innerWidth}>
        {entry.streaming === true ? (
          <StreamingMarkdown source={entry.text} width={innerWidth} />
        ) : (
          <Markdown source={entry.text} forceWidth={innerWidth} />
        )}
      </Box>
    </Box>
  );
}

export function ThinkingRow({ text }: { text: string; streaming?: boolean }): React.JSX.Element {
  return (
    <Box flexDirection="row" marginTop={1} width="100%">
      <Box minWidth={2}>
        <Text italic dim>
          {Glyph.therefore}
        </Text>
      </Box>
      <Box flexDirection="column" flexGrow={1}>
        <Markdown source={text.trim()} dim />
      </Box>
    </Box>
  );
}

const REPORT_PATH_RE = /(\/\S+\.md)\b/;

function withReportLink(text: string): string {
  if (!supportsHyperlinks()) return text;
  return text.replace(REPORT_PATH_RE, (path) => osc8FileLink({ path, label: path }));
}

export function SkillCompletionRow({
  text,
  isError,
}: {
  text: string;
  isError: boolean;
}): React.JSX.Element {
  return (
    <Box flexDirection="row" marginTop={1}>
      <Text color={isError ? Color.error : Color.assistant}>{`${Glyph.bullet} `}</Text>
      <Box flexGrow={1}>
        <Text color={Color.text}>{withReportLink(text)}</Text>
      </Box>
    </Box>
  );
}

type FileRead = { path: string; numLines: number };

function FileReadLine({ gutter, file }: { gutter: string; file: FileRead }): React.JSX.Element {
  const lineLabel = file.numLines === 1 ? "line" : "lines";
  return (
    <Box flexDirection="row">
      <Text color={Color.muted}>{gutter}</Text>
      <Text
        color={Color.muted}
      >{`Read ${getDisplayPath(file.path)} (${file.numLines} ${lineLabel})`}</Text>
    </Box>
  );
}

export function CompactionRow({
  text,
  filesRead,
}: {
  text: string;
  filesRead: FileRead[];
}): React.JSX.Element {
  const [firstFile, ...restFiles] = filesRead;
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box flexDirection="row">
        <Text color={colorFor("compaction")}>{prefixFor("compaction")}</Text>
        <Box flexDirection="column" flexGrow={1}>
          <Text color={Color.muted}>{text}</Text>
        </Box>
      </Box>
      {!!firstFile && <FileReadLine gutter={GUTTER_HEAD} file={firstFile} />}
      {restFiles.map((file) => (
        <FileReadLine key={file.path} gutter={GUTTER_CONT} file={file} />
      ))}
    </Box>
  );
}
