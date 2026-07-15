import { AnsiText, Box, Text, useTerminalDimensions } from "@/ink";
import { formatElapsed } from "@/ui/chrome/progress/index.ts";
import { Color, GUTTER_CONT, GUTTER_HEAD } from "@/ui/theme/theme.ts";
import {
  agentModelSuffix,
  bashHeaderCommand,
  displayModelName,
  displayNameFor,
  resolveArgBody,
  resolveArgSegments,
} from "@/ui/transcript/tool-render/args.ts";
import { renderDiffLines } from "@/ui/transcript/tool-render/diff.tsx";
import { wrapShellOutput } from "@/ui/transcript/tool-render/format.ts";
import { formatNestedEntry } from "@/ui/transcript/tool-render/payload.ts";
import { renderPayload } from "@/ui/transcript/tool-render/payload-view.tsx";
import {
  type NestedEntry,
  type ToolPayload,
  type ToolStatus,
} from "@/ui/transcript/tool-render/types.ts";
import { ToolUseLoader } from "./use-loader.tsx";

export {
  displayModelName,
  formatNumberCompact,
  summarizeArgSegments,
  summarizeArgs,
  supportsHyperlinks,
} from "@/ui/transcript/tool-render/args.ts";
export {
  payloadFromError,
  payloadFromMeta,
  payloadFromResult,
} from "@/ui/transcript/tool-render/payload.ts";
export type { NestedEntry, ToolPayload, ToolStatus };
export { displayNameFor, formatNestedEntry, renderDiffLines, wrapShellOutput };

const TOOL_PROGRESS_TAIL = 3;
const HEAD_LOADER_WIDTH = 2;

export interface ToolRenderProps {
  name: string;
  args: unknown;
  status: ToolStatus;
  elapsedMs?: number;
  payload?: ToolPayload | null;
  spinnerTick?: number;
  nestedEntries?: NestedEntry[];
  isBackgrounded?: boolean;
  agentSuffix?: string;
  providerShortKey: string;
  currentModel?: string;
  producedModel?: string;
  visionModel?: string;
  hooks?: import("@/engine/tools/contract.ts").ToolRenderHooks;
}

export function ToolRender(props: ToolRenderProps): React.JSX.Element {
  const {
    name,
    args,
    status,
    elapsedMs,
    payload = null,
    spinnerTick = 0,
    nestedEntries = [],
    isBackgrounded = false,
    agentSuffix,
    providerShortKey,
    currentModel,
    producedModel,
    visionModel,
  } = props;

  const { columns, rows } = useTerminalDimensions();
  const displayedName = props.hooks?.userFacingName?.(args) ?? displayNameFor(name, args);
  if (displayedName === "") return <Box />;
  const argSegments = resolveArgSegments(props.hooks, name, args);
  const headColumnWidth = Math.max(1, columns - HEAD_LOADER_WIDTH);
  const argsUnderParen = name === "Workflow" || name === "Bash";
  const argColumnWidth = argsUnderParen
    ? Math.max(1, columns - HEAD_LOADER_WIDTH - displayedName.length)
    : headColumnWidth;
  const bashCommand = name === "Bash" ? bashHeaderCommand(args) : null;
  const argBody = resolveArgBody({
    name,
    bashCommand,
    argSegments,
  });
  const hasArgBody = bashCommand !== null ? bashCommand.length > 0 : argSegments.length > 0;
  const computedSuffix =
    agentSuffix ?? agentModelSuffix(name, args, providerShortKey, currentModel);
  const showsProducer = name === "Agent" || name === "GenerateImage";
  const producerHint = showsProducer && producedModel ? displayModelName(producedModel) : undefined;
  // A nested tool whose display name resolves to "" (ToolSearch, Task*,
  // AskUserQuestion, plan-mode) is hidden at the top level too — rendering it
  // here would leave a bare gutter line (height-reserving, empty). Drop it so
  // the count and gutter stay honest. SoT for the empty set: DISPLAY_NAME_OVERRIDES.
  const visibleNested = nestedEntries.filter((e) => displayNameFor(e.toolName, e.args) !== "");

  void spinnerTick;
  const lines: React.JSX.Element[] = [];

  lines.push(
    <Box key="head" flexDirection="row">
      <ToolUseLoader
        isError={status === "error"}
        isUnresolved={status === "running" || status === "queued"}
        shouldAnimate={status === "running" && !isBackgrounded}
      />
      {argsUnderParen ? (
        <>
          <Box flexShrink={0}>
            <Text color={Color.titleStrong} bold>
              {displayedName}
            </Text>
          </Box>
          {hasArgBody && (
            <Box width={argColumnWidth}>
              <Text>
                <Text color={Color.toolBody}>{`(${argBody})`}</Text>
                {!!producerHint && <Text color={Color.muted}>{` ${producerHint}`}</Text>}
              </Text>
            </Box>
          )}
          {!hasArgBody && !!producerHint && <Text color={Color.muted}>{` ${producerHint}`}</Text>}
        </>
      ) : (
        <Box flexDirection="column" width={headColumnWidth}>
          <Text>
            <Text color={Color.titleStrong} bold>
              {displayedName}
            </Text>
            {hasArgBody && (
              <Text color={Color.toolBody}>
                (<AnsiText>{argBody}</AnsiText>)
              </Text>
            )}
            {name === "Agent" && !!computedSuffix && (
              <Text color={Color.muted}> {computedSuffix}</Text>
            )}
            {!!producerHint && producerHint !== computedSuffix && (
              <Text color={Color.muted}> {producerHint}</Text>
            )}
            {name === "Read" && !!visionModel && (
              <Text color={Color.muted}> Vision by {visionModel}</Text>
            )}
          </Text>
        </Box>
      )}
    </Box>,
  );

  if (name === "Agent" && status === "running" && !isBackgrounded && visibleNested.length === 0) {
    lines.push(
      <Box key="init" height={1} overflowY="hidden">
        <Text wrap="truncate">
          <Text color={Color.muted}>{GUTTER_HEAD}</Text>
          <Text color={Color.muted}>Initializing…</Text>
        </Text>
      </Box>,
    );
  }

  if (isBackgrounded) {
    const label =
      name === "Bash"
        ? "Running in the background (↓ to manage)"
        : "Backgrounded agent (↓ to manage)";
    lines.push(
      <Text key="bg-preview">
        <Text color={Color.muted}>{GUTTER_HEAD}</Text>
        <Text color={Color.muted}>{label}</Text>
      </Text>,
    );
    return <Box flexDirection="column">{lines}</Box>;
  }

  lines.push(...renderNestedProgress(visibleNested, name, status, rows, columns));

  if (payload) {
    lines.push(...renderPayload(payload, lines.length > 1, columns, status === "error"));
  }

  if (name === "Bash" && status === "running") {
    if (!payload) {
      const elapsedSuffix = typeof elapsedMs === "number" ? ` (${formatElapsed(elapsedMs)})` : "";
      lines.push(
        <Text key="running-head">
          <Text color={Color.muted}>{GUTTER_HEAD}</Text>
          <Text color={Color.muted}>{`Running…${elapsedSuffix}`}</Text>
        </Text>,
      );
    }
    lines.push(
      <Text key="running-hint">
        <Text color={Color.muted}>{GUTTER_CONT}</Text>
        <Text color={Color.muted}>{backgroundHintText()}</Text>
      </Text>,
    );
  }

  if (name === "Agent" && status === "running" && !isBackgrounded) {
    lines.push(
      <Text key="hint">
        <Text color={Color.muted}>{GUTTER_CONT}</Text>
        <Text color={Color.muted}>{backgroundHintText()}</Text>
      </Text>,
    );
  }

  return <Box flexDirection="column">{lines}</Box>;
}

function backgroundHintText(): string {
  return process.env.TMUX !== undefined
    ? "(ctrl+b ctrl+b (twice) to run in background)"
    : "(ctrl+b to run in background)";
}

function renderNestedProgress(
  visibleNested: NestedEntry[],
  name: string,
  status: ToolStatus,
  rows: number,
  columns: number,
): React.JSX.Element[] {
  const total = visibleNested.length;
  const cap = TOOL_PROGRESS_TAIL;
  const hidden = Math.max(0, total - cap);
  const visibleStart = Math.max(0, total - cap);
  const out: React.JSX.Element[] = [];
  for (let rel = 0; rel < total - visibleStart; rel++) {
    const absoluteIndex = visibleStart + rel;
    const entry = visibleNested[absoluteIndex];
    if (!entry) continue;
    const [label, inner] = formatNestedEntry(entry);
    const prefix = rel === 0 ? GUTTER_HEAD : GUTTER_CONT;
    out.push(
      <Box key={`nested_${absoluteIndex}`} height={1} overflowY="hidden">
        <Text wrap="truncate">
          <Text color={Color.muted}>{prefix}</Text>
          <Text color={Color.titleStrong} bold>
            {label}
          </Text>
          {inner.length > 0 && <Text color={Color.toolBody}>({inner})</Text>}
        </Text>
      </Box>,
    );
  }
  if (hidden > 0) {
    const plural = hidden === 1 ? "use" : "uses";
    out.push(
      <Box key="hidden" height={1} overflowY="hidden">
        <Text wrap="truncate">
          <Text color={Color.muted}>{GUTTER_CONT}</Text>
          <Text color={Color.muted}>{`+${hidden} more tool ${plural}`}</Text>
        </Text>
      </Box>,
    );
  }
  return out;
}
