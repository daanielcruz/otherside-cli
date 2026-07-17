import { memo, useSyncExternalStore } from "react";
import {
  isActive as designSessionActive,
  subscribe as subscribeDesign,
} from "@/design/spawn-registry.ts";
import { Box, type Color as InkColor, Text, useFrameClock, useTerminalDimensions } from "@/ink";
import type { BrokerState } from "@/store/app-store/broker.ts";
import { usePromptSelector } from "@/store/prompt/index.ts";
import { Color, Glyph } from "@/ui/theme/theme.ts";

export interface VoiceStatus {
  phase: "idle" | "warmup" | "recording" | "processing";
  message: string | null;
}

export interface HistorySearchStatus {
  query: string;
  failed: boolean;
}

export interface StatusBarProps {
  state: BrokerState;
  width: number;
  busy?: boolean;
  exitHint?: string | undefined;
  historySearch?: HistorySearchStatus | undefined;
  bgTaskLabel?: string | undefined;
  bgTaskFocused?: boolean;
  remoteSyncStatus?: "disconnected" | "connecting" | "active";
  clipboardHint?: boolean | undefined;
  goalLabel?: string | undefined;
  panelHint?: string | undefined;
  voice?: VoiceStatus | undefined;
}

const VOICE_PROCESSING_DIM = 153;
const VOICE_PROCESSING_BRIGHT = 185;
const VOICE_PULSE_PERIOD_S = 2;

function VoiceProcessingText(): React.JSX.Element {
  const [ref, time] = useFrameClock(50);
  const opacity = (Math.sin(((time / 1000) * Math.PI * 2) / VOICE_PULSE_PERIOD_S) + 1) / 2;
  const channel = Math.round(
    VOICE_PROCESSING_DIM + (VOICE_PROCESSING_BRIGHT - VOICE_PROCESSING_DIM) * opacity,
  );
  const hex: `#${string}` = `#${channel.toString(16).padStart(2, "0").repeat(3)}`;
  return (
    <Box ref={ref}>
      <Text color={hex}>Voice: processing…</Text>
    </Box>
  );
}

interface PermissionChip {
  symbol: string;
  text: string;
  color: InkColor;
}

function permissionChip(state: BrokerState): PermissionChip | null {
  const fastForward = Glyph.fastForward.repeat(2);
  if (state.permissionMode === "yolo") {
    return { symbol: fastForward, text: "yolo mode on", color: Color.modeYolo };
  }
  if (state.permissionMode === "plan") {
    return { symbol: Glyph.pause, text: "plan mode on", color: Color.modePlan };
  }
  if (state.permissionMode === "accept-edits") {
    return { symbol: fastForward, text: "accept edits on", color: Color.modeAccept };
  }
  return null;
}

// Left status slot, by precedence: history search, exit hint, panel hint,
// the bash-mode hint, then the permission-mode chip with its background-task
// label.
function LeftSlot({
  historySearch,
  exitHint,
  panelHint,
  bashMode,
  chip,
  bgTaskLabel,
  bgTaskFocused,
}: {
  historySearch: HistorySearchStatus | undefined;
  exitHint: string | undefined;
  panelHint: string | undefined;
  bashMode: boolean;
  chip: PermissionChip | null;
  bgTaskLabel: string | undefined;
  bgTaskFocused: boolean;
}): React.JSX.Element | null {
  if (historySearch !== undefined) {
    return (
      <>
        <Text color={Color.muted} dim>
          {historySearch.failed ? "no matching prompt:" : "search prompts:"}{" "}
        </Text>
        <Text color={Color.muted}>{historySearch.query}</Text>
        <Text inverse> </Text>
      </>
    );
  }
  if (exitHint !== undefined) return <Text color={Color.muted}>{exitHint}</Text>;
  if (panelHint !== undefined) return <Text color={Color.muted}>{panelHint}</Text>;
  if (bashMode) return <Text color={Color.bashMode}>! for shell mode</Text>;
  if (chip === null) return null;
  return (
    <>
      <Text color={chip.color} bold>
        {chip.symbol}{" "}
      </Text>
      <Text color={chip.color} bold>
        {chip.text}
      </Text>
      {bgTaskLabel ? (
        <>
          <Text color={Color.muted}> · </Text>
          {bgTaskFocused ? (
            <Text color={Color.queueBackground} backgroundColor={Color.primaryGlow} bold>
              {" "}
              {bgTaskLabel}{" "}
            </Text>
          ) : (
            <Text color={Color.primaryGlow}>{bgTaskLabel}</Text>
          )}
        </>
      ) : (
        // The ctrl+t task-visibility hint lives next to the collapsed
        // "Next:" gutter line; the mode chip keeps the shift+tab hint.
        <Text color={Color.muted}> (shift+tab to cycle)</Text>
      )}
    </>
  );
}

function StatusBarImpl({
  state,
  width,
  busy = false,
  exitHint,
  historySearch,
  bgTaskLabel,
  bgTaskFocused = false,
  remoteSyncStatus,
  clipboardHint,
  goalLabel,
  panelHint,
  voice,
}: StatusBarProps): React.JSX.Element {
  void busy;
  const chip = permissionChip(state);
  const bashMode = usePromptSelector((s) => s.bashMode);
  const designActive = useSyncExternalStore(
    subscribeDesign,
    designSessionActive,
    designSessionActive,
  );
  const remoteShown = remoteSyncStatus !== undefined && remoteSyncStatus !== "disconnected";
  const isRemoteActive = remoteShown && remoteSyncStatus === "active";
  const bothActive = isRemoteActive && designActive;
  const voicePhase = voice?.phase ?? "idle";
  // While voice is recording or processing, the voice indicator replaces the
  // right-hand status cluster. Warmup renders nothing: it toggles with every
  // key-repeat burst, so any hint would flicker before capture engages.
  if (voicePhase === "recording" || voicePhase === "processing") {
    return (
      <Box flexDirection="column" width={width}>
        <Box width="100%" justifyContent="space-between" paddingX={2}>
          <Box>
            {chip !== null && (
              <>
                <Text color={chip.color} bold>
                  {chip.symbol}{" "}
                </Text>
                <Text color={chip.color} bold>
                  {chip.text}
                </Text>
                <Text color={Color.muted}> (shift+tab to cycle)</Text>
              </>
            )}
          </Box>
          {voicePhase === "recording" ? (
            <Text color={Color.muted}>listening…</Text>
          ) : (
            <VoiceProcessingText />
          )}
        </Box>
        {voice?.message && (
          <Box width="100%" justifyContent="flex-end" paddingX={2}>
            <Text color={Color.error}>{voice.message}</Text>
          </Box>
        )}
      </Box>
    );
  }
  return (
    <Box flexDirection="column" width={width}>
      <Box width="100%" justifyContent="space-between" paddingX={2}>
        <Box>
          <LeftSlot
            historySearch={historySearch}
            exitHint={exitHint}
            panelHint={panelHint}
            bashMode={bashMode}
            chip={chip}
            bgTaskLabel={bgTaskLabel}
            bgTaskFocused={bgTaskFocused}
          />
        </Box>
        <Box>
          {clipboardHint === true && (
            <Text color={Color.muted} dim>
              Image in clipboard · ctrl+v to paste
            </Text>
          )}
          {!!goalLabel && (
            <>
              {clipboardHint === true && <Text color={Color.muted}> · </Text>}
              <Text color={Color.primaryGlow}>{goalLabel}</Text>
            </>
          )}
          {bothActive ? (
            <>
              {(clipboardHint === true || !!goalLabel) && <Text color={Color.muted}> · </Text>}
              <Text color={Color.success} bold>
                Remote & Design sessions active
              </Text>
            </>
          ) : (
            <>
              {remoteShown && (
                <>
                  {(clipboardHint === true || !!goalLabel) && <Text color={Color.muted}> · </Text>}
                  {remoteSyncStatus === "active" ? (
                    <Text color={Color.success} bold>
                      Remote Session active
                    </Text>
                  ) : (
                    <Text color={Color.warning} bold>
                      Remote Session connecting...
                    </Text>
                  )}
                </>
              )}
              {designActive && (
                <>
                  {(clipboardHint === true || !!goalLabel || remoteShown) && (
                    <Text color={Color.muted}> · </Text>
                  )}
                  <Text color={Color.designSession} bold>
                    Design session active
                  </Text>
                </>
              )}
            </>
          )}
        </Box>
      </Box>
      {voice?.message && (
        <Box width="100%" justifyContent="flex-end" paddingX={2}>
          <Text color={Color.error}>{voice.message}</Text>
        </Box>
      )}
    </Box>
  );
}

const StatusBarInner = memo(StatusBarImpl);

export function StatusBar(props: Omit<StatusBarProps, "width">): React.JSX.Element {
  const { columns } = useTerminalDimensions();
  return <StatusBarInner {...props} width={columns} />;
}
