import { memo, useSyncExternalStore } from "react";
import {
  isActive as designSessionActive,
  subscribe as subscribeDesign,
} from "@/design/spawn-registry.ts";
import { Box, type Color as InkColor, Text, useTerminalDimensions } from "@/ink";
import type { BrokerState } from "@/store/app-store/broker.ts";
import { Color, Glyph } from "@/ui/theme/theme.ts";

export interface StatusBarProps {
  state: BrokerState;
  width: number;
  busy?: boolean;
  exitHint?: string | undefined;
  bgTaskLabel?: string | undefined;
  bgTaskFocused?: boolean;
  remoteSyncStatus?: "disconnected" | "connecting" | "active";
  clipboardHint?: boolean | undefined;
  goalLabel?: string | undefined;
  panelHint?: string | undefined;
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

function StatusBarImpl({
  state,
  width,
  busy = false,
  exitHint,
  bgTaskLabel,
  bgTaskFocused = false,
  remoteSyncStatus,
  clipboardHint,
  goalLabel,
  panelHint,
}: StatusBarProps): React.JSX.Element {
  void busy;
  const chip = permissionChip(state);
  const designActive = useSyncExternalStore(
    subscribeDesign,
    designSessionActive,
    designSessionActive,
  );
  const remoteShown = remoteSyncStatus !== undefined && remoteSyncStatus !== "disconnected";
  const isRemoteActive = remoteShown && remoteSyncStatus === "active";
  const bothActive = isRemoteActive && designActive;
  return (
    <Box width={width} justifyContent="space-between" paddingX={2}>
      <Box>
        {exitHint !== undefined ? (
          <Text color={Color.muted}>{exitHint}</Text>
        ) : panelHint !== undefined ? (
          <Text color={Color.muted}>{panelHint}</Text>
        ) : (
          chip !== null && (
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
          )
        )}
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
  );
}

const StatusBarInner = memo(StatusBarImpl);

export function StatusBar(props: Omit<StatusBarProps, "width">): React.JSX.Element {
  const { columns } = useTerminalDimensions();
  return <StatusBarInner {...props} width={columns} />;
}
