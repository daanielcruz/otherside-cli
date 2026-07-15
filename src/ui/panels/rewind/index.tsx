import { useEffect, useMemo, useState } from "react";
import { Box, Text, useTerminalDimensions } from "@/ink";
import {
  fileRestoreDiffStatsForTurn,
  fileSnapshotStatsForTurn,
  type RestoreDiffStats,
} from "@/kernel/storage/file-history.ts";
import type { RewindMode } from "@/ui/app.tsx";
import { FooterPanel, FooterPanelPickerRow } from "@/ui/chrome/panel.tsx";
import { pickerMaxHeight } from "@/ui/chrome/picker-geometry.ts";
import { usePanelNavigation } from "@/ui/hooks/use-panel-navigation.ts";
import { useOverlayState } from "@/ui/panels/context";
import { useOverlayClose } from "@/ui/panels/use-overlay-close";
import { Color, Glyph } from "@/ui/theme/theme.ts";

export interface RewindUserTurn {
  id: string;
  ts?: string;
  text: string;
}

export interface RewindOverlayProps {
  sessionId?: string;
  userTurns?: RewindUserTurn[];
  onRewind?: (id: string, mode?: RewindMode) => void;
  onClose?: () => void;
}

export interface RewindTurn {
  kind: "turn";
  id: string;
  preview: string;
  filesChanged: number;
  firstFileBasename?: string;
  timestamp?: string;
}

interface CurrentTurn {
  kind: "current";
  id: "__current";
}

type RewindOption = RewindTurn | CurrentTurn;
type RestoreOption = RewindMode | "nevermind";

export const REWIND_ROW_HEIGHT = 3;
const REWIND_CHROME_ROWS = 12;

export function visibleRewindRows(terminalRows: number, rowHeight = REWIND_ROW_HEIGHT): number {
  // Same 65% height budget as /resume so the two pickers read as one surface.
  return Math.max(2, Math.floor((pickerMaxHeight(terminalRows) - REWIND_CHROME_ROWS) / rowHeight));
}

export function clampRewindIndex(index: number, count: number): number {
  return Math.max(0, Math.min(Math.max(0, count - 1), index));
}

export function pageRewindIndex(
  index: number,
  count: number,
  direction: 1 | -1,
  visibleRows: number,
): number {
  return clampRewindIndex(index + direction * visibleRows, count);
}

export function numericConfirmationIndex(input: string, count: number): number | null {
  if (!/^[1-9]$/.test(input)) return null;
  const index = Number(input) - 1;
  return index < count ? index : null;
}

function footerHintsFor(confirming: boolean, hasMessagesToSelect: boolean): [string, string][] {
  if (confirming)
    return [
      ["1-9", "choose"],
      ["Enter", "confirm"],
      ["Esc", "back"],
    ];
  if (hasMessagesToSelect)
    return [
      ["Enter", "continue"],
      ["Esc", "cancel"],
    ];
  return [["Esc", "cancel"]];
}

function RewindBody({
  hasMessagesToSelect,
  confirmTurn,
  restoreOptions,
  restoreIdx,
  diffStats,
  options,
  idx,
  visibleRows,
}: {
  hasMessagesToSelect: boolean;
  confirmTurn: RewindTurn | null;
  restoreOptions: Array<{ mode: RestoreOption; label: string }>;
  restoreIdx: number;
  diffStats: RestoreDiffStats | null;
  options: RewindOption[];
  idx: number;
  visibleRows: number;
}): React.JSX.Element {
  if (!hasMessagesToSelect) {
    return <Text color={Color.text}>Nothing to rewind to yet.</Text>;
  }
  if (confirmTurn) {
    return (
      <ConfirmRestore
        turn={confirmTurn}
        options={restoreOptions}
        selectedIndex={restoreIdx}
        diffStats={diffStats}
      />
    );
  }
  return <Picker options={options} selectedIndex={idx} visibleRows={visibleRows} />;
}

export function RewindOverlay({
  sessionId,
  userTurns,
  onRewind,
  onClose,
}: RewindOverlayProps = {}): React.JSX.Element {
  const { rows: terminalRows } = useTerminalDimensions();
  const visibleRows = visibleRewindRows(terminalRows);
  const overlayState = useOverlayState();
  const sid = sessionId ?? overlayState.session.id;
  const close = useOverlayClose(onClose);
  const sourceTurns = userTurns ?? [];
  const turns = useMemo(() => rewindTurns(sourceTurns, sid), [sourceTurns, sid]);
  const options = useMemo<RewindOption[]>(
    () => [...turns, { kind: "current", id: "__current" }],
    [turns],
  );
  const [idx, setIdx] = useState(Math.max(0, options.length - 1));
  const [confirmTurn, setConfirmTurn] = useState<RewindTurn | null>(null);

  useEffect(() => {
    setIdx((current) => clampRewindIndex(current, options.length));
  }, [options.length, visibleRows]);
  const restoreOptions = useMemo(
    () => restoreOptionsFor(confirmTurn?.filesChanged ?? 0),
    [confirmTurn],
  );
  const diffStats = useMemo<RestoreDiffStats | null>(
    () =>
      confirmTurn && confirmTurn.filesChanged > 0 && sid.length > 0
        ? fileRestoreDiffStatsForTurn(sid, confirmTurn.id)
        : null,
    [confirmTurn, sid],
  );
  const [restoreIdx, setRestoreIdx] = useState(0);
  const hasMessagesToSelect = turns.length > 0;

  usePanelNavigation({
    onClose: close,
    onBack: () => {
      if (confirmTurn) {
        setConfirmTurn(null);
        return true;
      }
      return false;
    },
    onKey: (input, key) => {
      if (!hasMessagesToSelect) return false;
      if (confirmTurn) {
        const numericIndex = numericConfirmationIndex(input, restoreOptions.length);
        if (numericIndex !== null) {
          const option = restoreOptions[numericIndex];
          if (option?.mode === "nevermind") setConfirmTurn(null);
          else if (option) onRewind?.(confirmTurn.id, option.mode);
          return true;
        }
        if (key.upArrow || input === "k") {
          setRestoreIdx((i) => Math.max(0, i - 1));
          return true;
        }
        if (key.downArrow || input === "j") {
          setRestoreIdx((i) => Math.min(Math.max(0, restoreOptions.length - 1), i + 1));
          return true;
        }
        if (key.return) {
          const option = restoreOptions[restoreIdx];
          if (!option) return true;
          if (option.mode === "nevermind") {
            setConfirmTurn(null);
            return true;
          }
          onRewind?.(confirmTurn.id, option.mode);
          return true;
        }
        return false;
      }
      const lastIndex = Math.max(0, options.length - 1);
      if (key.shift && (input === "k" || input === "K")) {
        setIdx(0);
        return true;
      }
      if (key.shift && (input === "j" || input === "J")) {
        setIdx(lastIndex);
        return true;
      }
      if ((key.ctrl || key.meta || key.shift) && key.upArrow) {
        setIdx(0);
        return true;
      }
      if ((key.ctrl || key.meta || key.shift) && key.downArrow) {
        setIdx(lastIndex);
        return true;
      }
      if (key.pageUp) {
        setIdx((i) => pageRewindIndex(i, options.length, -1, visibleRows));
        return true;
      }
      if (key.pageDown) {
        setIdx((i) => pageRewindIndex(i, options.length, 1, visibleRows));
        return true;
      }
      if (key.upArrow || input === "k" || (key.ctrl && input === "p")) {
        setIdx((i) => Math.max(0, i - 1));
        return true;
      }
      if (key.downArrow || input === "j" || (key.ctrl && input === "n")) {
        setIdx((i) => Math.min(lastIndex, i + 1));
        return true;
      }
      if (key.return) {
        const option = options[idx];
        if (!option || option.kind === "current") {
          close();
          return true;
        }
        const defaultRestore = restoreOptionsFor(option.filesChanged);
        const defaultIdx = defaultRestore.findIndex(
          (entry) => entry.mode === (option.filesChanged > 0 ? "both" : "conversation"),
        );
        setConfirmTurn(option);
        setRestoreIdx(defaultIdx >= 0 ? defaultIdx : 0);
        return true;
      }
      return false;
    },
  });

  const footerHints = footerHintsFor(!!confirmTurn, hasMessagesToSelect);

  const counterText =
    !confirmTurn && hasMessagesToSelect
      ? `(${Math.min(idx + 1, options.length)} of ${options.length})`
      : null;
  const titleNode = (
    <Box>
      <Text color={Color.primaryGlow} bold>
        Rewind
      </Text>
      {counterText !== null && <Text color={Color.muted}> {counterText}</Text>}
    </Box>
  );

  return (
    <FooterPanel title={titleNode} footerHints={footerHints}>
      <RewindBody
        hasMessagesToSelect={hasMessagesToSelect}
        confirmTurn={confirmTurn}
        restoreOptions={restoreOptions}
        restoreIdx={restoreIdx}
        diffStats={diffStats}
        options={options}
        idx={idx}
        visibleRows={visibleRows}
      />
    </FooterPanel>
  );
}

function Picker({
  options,
  selectedIndex,
  visibleRows,
}: {
  options: RewindOption[];
  selectedIndex: number;
  visibleRows: number;
}): React.JSX.Element {
  const firstVisible = Math.max(
    0,
    Math.min(selectedIndex - Math.floor(visibleRows / 2), options.length - visibleRows),
  );
  const lastVisible = Math.min(options.length, firstVisible + visibleRows);
  const visible = options.slice(firstVisible, lastVisible);
  const showTopGap = firstVisible > 0;
  const showBottomGap = lastVisible < options.length;
  return (
    <Box flexDirection="column">
      <Text color={Color.text}>Restore the code and/or conversation to the point before…</Text>
      <Box flexDirection="column" marginTop={1}>
        {showTopGap && (
          <Box paddingLeft={2}>
            <Text color={Color.muted}>↑ {firstVisible} more above</Text>
          </Box>
        )}
        {visible.map((option, visibleIndex) => (
          <RewindOptionRow
            key={option.id}
            option={option}
            selected={firstVisible + visibleIndex === selectedIndex}
          />
        ))}
        {showBottomGap && (
          <Box paddingLeft={2}>
            <Text color={Color.muted}>↓ {options.length - lastVisible} more below</Text>
          </Box>
        )}
      </Box>
    </Box>
  );
}

function RewindOptionRow({
  option,
  selected,
}: {
  option: RewindOption;
  selected: boolean;
}): React.JSX.Element {
  if (option.kind === "current") {
    return <FooterPanelPickerRow label="(current)" selected={selected} labelItalic />;
  }
  return (
    <FooterPanelPickerRow
      label={option.preview}
      description={filesChangedLabel(option)}
      selected={selected}
    />
  );
}

function ConfirmRestore({
  turn,
  options,
  selectedIndex,
  diffStats,
}: {
  turn: RewindTurn;
  options: Array<{ mode: RestoreOption; label: string }>;
  selectedIndex: number;
  diffStats: RestoreDiffStats | null;
}): React.JSX.Element {
  const selected = options[selectedIndex]?.mode ?? "conversation";
  const restoresConversation = selected === "conversation" || selected === "both";
  const restoresCode = selected === "code" || selected === "both";
  const relative = turn.timestamp ? formatRelativeTimeAgo(new Date(turn.timestamp)) : null;
  const showDiffStat =
    restoresCode && diffStats !== null && (diffStats.insertions > 0 || diffStats.deletions > 0);
  return (
    <Box flexDirection="column">
      <Text color={Color.text}>
        Confirm you want to restore to the point before you sent this message:
      </Text>
      <Box flexDirection="column" marginTop={1}>
        <Box>
          <Text color={Color.muted}>│ </Text>
          <Text color={Color.text}>{turn.preview}</Text>
        </Box>
        {relative !== null && (
          <Box>
            <Text color={Color.muted}>│ </Text>
            <Text color={Color.muted}>({relative})</Text>
          </Box>
        )}
      </Box>
      <Box flexDirection="column" marginTop={1}>
        <Text color={Color.muted}>
          {restoresConversation
            ? "The conversation will be forked."
            : "The conversation will be unchanged."}
        </Text>
        <Text color={Color.muted}>
          {restoresCode ? (
            <>
              {`${turn.filesChanged} file${turn.filesChanged === 1 ? "" : "s"} will be restored.`}
              {showDiffStat && diffStats !== null && (
                <>
                  {" "}
                  <Text color={Color.diffAddFg}>+{diffStats.insertions}</Text>{" "}
                  <Text color={Color.diffRemFg}>-{diffStats.deletions}</Text>
                </>
              )}
            </>
          ) : (
            "The code will be unchanged."
          )}
        </Text>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {options.map((option, index) => (
          <Box key={option.mode}>
            <Text color={index === selectedIndex ? Color.highlight : Color.text}>
              {index === selectedIndex ? Glyph.chevron : "  "}
              {index + 1}. {option.label}
            </Text>
          </Box>
        ))}
      </Box>
      {turn.filesChanged > 0 && (
        <Box marginTop={1}>
          <Text color={Color.muted}>
            ⚠ Rewinding does not affect files edited manually or via bash.
          </Text>
        </Box>
      )}
    </Box>
  );
}

export function rewindTurns(userTurns: readonly RewindUserTurn[], sessionId = ""): RewindTurn[] {
  return userTurns.map((turn) => {
    const stats =
      sessionId.length > 0 ? fileSnapshotStatsForTurn(sessionId, turn.id) : { filesChanged: [] };
    const first = stats.filesChanged[0];
    return {
      kind: "turn",
      id: turn.id,
      preview: clip(turn.text, 96),
      filesChanged: stats.filesChanged.length,
      ...(first ? { firstFileBasename: basename(first) } : {}),
      ...(turn.ts ? { timestamp: turn.ts } : {}),
    };
  });
}

function basename(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i >= 0 ? p.slice(i + 1) : p;
}

function filesChangedLabel(option: RewindTurn): string {
  if (option.filesChanged === 0) return "No code changes";
  if (option.filesChanged === 1 && option.firstFileBasename) {
    return `${option.firstFileBasename} changed`;
  }
  return `${option.filesChanged} files changed`;
}

export function formatRelativeTimeAgo(date: Date, now: Date = new Date()): string {
  const diffMs = date.getTime() - now.getTime();
  const seconds = Math.trunc(diffMs / 1000);
  const abs = Math.abs(seconds);
  const intervals = [
    { unit: "y", s: 31_536_000 },
    { unit: "mo", s: 2_592_000 },
    { unit: "w", s: 604_800 },
    { unit: "d", s: 86_400 },
    { unit: "h", s: 3_600 },
    { unit: "m", s: 60 },
    { unit: "s", s: 1 },
  ] as const;
  for (const { unit, s } of intervals) {
    if (abs >= s) {
      const value = Math.trunc(abs / s);
      return seconds <= 0 ? `${value}${unit} ago` : `in ${value}${unit}`;
    }
  }
  return seconds <= 0 ? "0s ago" : "in 0s";
}

function restoreOptionsFor(filesChanged: number): Array<{ mode: RestoreOption; label: string }> {
  if (filesChanged > 0) {
    return [
      { mode: "both", label: "Restore code and conversation" },
      { mode: "conversation", label: "Restore conversation" },
      { mode: "code", label: "Restore code" },
      { mode: "nevermind", label: "Never mind" },
    ];
  }
  return [
    { mode: "conversation", label: "Restore conversation" },
    { mode: "nevermind", label: "Never mind" },
  ];
}

function clip(text: string, max: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, Math.max(0, max - 1))}…`;
}
