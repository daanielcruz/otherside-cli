import { useContext, useEffect, useMemo, useRef, useState } from "react";
import { listCompletions, looksLikeCommand, lookup as lookupSlash } from "@/commands/index.ts";
import { notifyInteractionActivity } from "@/devtools/memory/gc-cadence.ts";
import {
  Box,
  colorize,
  Text,
  TimekeeperContext,
  useCursorOwner,
  useInput,
  useIsTerminalFocused,
  usePaste,
  useTerminalDimensions,
} from "@/ink";
import { createAutoClearDispatch } from "@/kernel/std/state/auto-clear-dispatch.ts";
import type { PasteStore } from "@/kernel/std/types/paste.ts";
import { setPromptMenuOpen } from "@/store/prompt/index.ts";
import { promptOwnsArrowNavigation } from "@/ui/input/arrow-navigation.ts";
import { Autocomplete } from "@/ui/input/autocomplete.tsx";
import { readImageFromClipboard } from "@/ui/input/paste/clipboard.ts";
import {
  joinWithLeadingSpace,
  maybeTruncateBuffer,
  PASTE_THRESHOLD,
  refEndingAt,
  refStartingAt,
} from "@/ui/input/paste/references.ts";
import {
  cursorDownPosition,
  cursorUpPosition,
  nextGraphemeBoundary,
  nextWordBoundary,
  prevGraphemeBoundary,
  prevWordBoundary,
  promptDisplayRows,
} from "@/ui/input/prompt-text.ts";
import { effortColor } from "@/ui/theme/effort-color.ts";
import { Color, Glyph } from "@/ui/theme/theme.ts";

export interface HistoryRestoreResult {
  value: string;
  offset: number;
  total: number;
}

export interface PromptProps {
  onSubmit: (text: string) => void;
  value?: string | undefined;
  onChange?: ((text: string) => void) | undefined;
  disabled?: boolean;
  frozenText?: string;
  queueHint?: boolean;
  fastModeActive?: boolean;
  effortLevel?: string | undefined;
  agentPill?: string | undefined;
  queuedRestoreEnabled?: boolean;
  onRestoreQueued?: () => string | null;
  onHistoryPrev?: (currentValue: string) => HistoryRestoreResult | null;
  onHistoryNext?: (currentValue: string) => HistoryRestoreResult | null;
  navLocked?: boolean;
  arrowNavigationLocked?: boolean;
  pasteStore?: PasteStore;
  imagePasteEnabled?: boolean;
  onUnsupportedImagePaste?: () => void;
  emptyDoubleEscapeEnabled?: boolean;
  onEmptyDoubleEscape?: () => void;
}

function badgeBorderText(input: {
  effortLevel: string | undefined;
  fastModeActive: boolean;
}): string | undefined {
  const { effortLevel, fastModeActive } = input;
  if (!fastModeActive && effortLevel === undefined) return undefined;
  const bold = (t: string): string => `\x1b[1m${t}\x1b[22m`;
  const parts: string[] = [];
  if (effortLevel !== undefined) {
    parts.push(bold(colorize(effortLevel, effortColor(effortLevel), "foreground")));
  }
  if (fastModeActive) {
    if (parts.length > 0) parts.push(colorize("·", Color.muted, "foreground"));
    parts.push(bold(colorize(Glyph.bolt, Color.fastMode, "foreground")));
  }
  return ` ${parts.join(" ")} `;
}

function PromptImpl({
  onSubmit,
  value,
  onChange,
  disabled = false,
  frozenText,
  queueHint = false,
  fastModeActive = false,
  effortLevel,
  agentPill,
  queuedRestoreEnabled = true,
  onRestoreQueued,
  onHistoryPrev,
  onHistoryNext,
  navLocked = false,
  arrowNavigationLocked = false,
  pasteStore,
  imagePasteEnabled = true,
  onUnsupportedImagePaste,
  emptyDoubleEscapeEnabled = true,
  onEmptyDoubleEscape,
}: PromptProps): React.JSX.Element {
  const [internalBuffer, setInternalBuffer] = useState("");
  const [rawCursor, setRawCursor] = useState(0);
  const [autoIdx, setAutoIdx] = useState(0);
  const [historyPos, setHistoryPos] = useState<{ offset: number; total: number } | null>(null);
  const { columns, rows } = useTerminalDimensions();
  const buffer = value ?? internalBuffer;
  const cursor = rawCursor;
  const inputSuspended = disabled || navLocked;
  const screenActive = useIsTerminalFocused();
  const promptOwnsInput = !inputSuspended && screenActive;
  const clock = useContext(TimekeeperContext);
  const escDispatch = useMemo(
    () =>
      createAutoClearDispatch({
        holdMs: 600,
        ...(clock?.setTimeout ? { scheduler: clock.setTimeout } : {}),
      }),
    [clock],
  );
  useEffect(() => {
    return () => escDispatch.clear();
  }, [escDispatch]);
  const internalEditRef = useRef(false);
  const draftRef = useRef<string | null>(null);
  const lastRestoredRef = useRef<string | null>(null);

  const latestBufferRef = useRef(buffer);
  const latestCursorRef = useRef(cursor);

  latestBufferRef.current = buffer;
  latestCursorRef.current = cursor;

  const setBufferValue = (next: string): void => {
    latestBufferRef.current = next;
    internalEditRef.current = true;
    if (value === undefined) setInternalBuffer(next);
    onChange?.(next);
  };

  const setCursor = (val: number | ((c: number) => number)): void => {
    if (typeof val === "function") {
      const nextVal = val(latestCursorRef.current);
      latestCursorRef.current = nextVal;
      setRawCursor(nextVal);
    } else {
      latestCursorRef.current = val;
      setRawCursor(val);
    }
  };

  const slashQuery =
    buffer.startsWith("/") && !disabled && historyPos === null ? buffer.slice(1) : null;
  const slashOptions = slashQuery !== null ? listCompletions(slashQuery) : [];
  const slashCommandToken = slashQuery !== null ? (slashQuery.split(/\s+/, 1)[0] ?? "") : "";
  const slashHasArgs =
    slashQuery !== null && slashQuery.slice(slashCommandToken.length).trim().length > 0;
  const matchedCommand =
    slashQuery !== null && /\s/.test(slashQuery) ? lookupSlash(slashCommandToken) : undefined;
  const slashNoMatch =
    slashQuery !== null &&
    slashQuery.length > 0 &&
    slashOptions.length === 0 &&
    !matchedCommand &&
    looksLikeCommand(slashCommandToken) &&
    !slashHasArgs;
  const argHint = (() => {
    if (!matchedCommand?.argumentHint) return null;
    const parts = slashQuery?.split(/\s+/, 2) ?? [];
    const remainder = parts[1] ?? "";
    if (remainder.length > 0) return null;
    return matchedCommand.argumentHint;
  })();

  useEffect(() => {
    setPromptMenuOpen(slashOptions.length > 0 || slashNoMatch);
  }, [slashOptions.length, slashNoMatch]);

  useEffect(() => {
    return () => setPromptMenuOpen(false);
  }, []);

  useEffect(() => {
    if (internalEditRef.current) {
      internalEditRef.current = false;
      setCursor((current) => Math.min(current, buffer.length));
      return;
    }
    setCursor(buffer.length);
  }, [buffer]);

  // Oversized buffers (history restore, queued sends — pastes are already
  // reference-compressed) collapse their middle into a truncated-text
  // reference so the input area stays responsive; submit re-expands it.
  // One-shot per fill: without the latch, an edit that pushes the truncated
  // buffer back over the threshold would swallow the user's own typing into
  // a second reference. The latch resets when the buffer empties (submit).
  const truncationAppliedRef = useRef(false);
  useEffect(() => {
    if (buffer.length === 0) {
      truncationAppliedRef.current = false;
      return;
    }
    if (truncationAppliedRef.current) return;
    if (!pasteStore) return;
    const truncated = maybeTruncateBuffer(buffer, pasteStore);
    if (truncated === null) return;
    truncationAppliedRef.current = true;
    setBufferValue(truncated);
    setCursor(truncated.length);
  }, [buffer]);

  useEffect(() => {
    if (historyPos === null) return;
    if (buffer === lastRestoredRef.current) return;
    // The recalled entry was edited — leave history: clear the position
    // indicator and drop the stashed draft so the next Up starts a fresh run.
    setHistoryPos(null);
    lastRestoredRef.current = null;
    draftRef.current = null;
  }, [buffer, historyPos]);

  usePaste(
    (pasted) => {
      if (inputSuspended) return;
      const buffer = latestBufferRef.current;
      const cursor = latestCursorRef.current;
      const normalized = pasted.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
      const numLines = (normalized.match(/\n/g) ?? []).length;
      // Line budget the input area can absorb without a full-terminal repaint —
      // an estimate, not the exact content height.
      const maxLines = Math.min(rows - 10, 2);
      if (pasteStore && (normalized.length > PASTE_THRESHOLD || numLines > maxLines)) {
        const { placeholder } = pasteStore.add({ type: "text", content: normalized });
        const { next, insertedLength } = joinWithLeadingSpace(buffer, cursor, placeholder);
        setBufferValue(next);
        setCursor((c) => c + insertedLength);
        return;
      }
      const next = buffer.slice(0, cursor) + normalized + buffer.slice(cursor);
      setBufferValue(next);
      setCursor((c) => c + normalized.length);
    },
    { isActive: !inputSuspended },
  );

  useInput((input, key, event) => {
    notifyInteractionActivity();
    if (inputSuspended) return;
    if (event.keypress.isPasted) return;

    const buffer = latestBufferRef.current;
    const cursor = latestCursorRef.current;

    if (
      !promptOwnsArrowNavigation({
        locked: arrowNavigationLocked,
        upArrow: key.upArrow,
        downArrow: key.downArrow,
        slashOptionCount: slashOptions.length,
      })
    ) {
      return;
    }

    if (key.escape && emptyDoubleEscapeEnabled) {
      if (buffer.length === 0 && onEmptyDoubleEscape && slashOptions.length === 0) {
        if (escDispatch.isArmed()) {
          escDispatch.clear();
          onEmptyDoubleEscape();
          return;
        }
        escDispatch.arm();
        return;
      }
    }
    if (key.ctrl && input === "v" && pasteStore) {
      const img = readImageFromClipboard();
      if (img) {
        if (!imagePasteEnabled) {
          onUnsupportedImagePaste?.();
          return;
        }
        const { placeholder } = pasteStore.add({
          type: "image",
          content: img.base64,
          mediaType: img.mediaType,
        });
        const { next, insertedLength } = joinWithLeadingSpace(buffer, cursor, placeholder);
        setBufferValue(next);
        setCursor((c) => c + insertedLength);
        return;
      }
    }
    const newlineIndex = input.search(/[\r\n]/);
    const returnKey = key.return || newlineIndex >= 0;

    if (slashOptions.length > 0) {
      if (key.upArrow) {
        setAutoIdx((i) => Math.max(0, i - 1));
        return;
      }
      if (key.downArrow) {
        setAutoIdx((i) => Math.min(slashOptions.length - 1, i + 1));
        return;
      }
      if (key.tab) {
        const opt = slashOptions[autoIdx];
        if (opt) {
          const next = `/${opt.name}`;
          setBufferValue(next);
          setCursor(next.length);
        }
        return;
      }
    }

    if (key.upArrow && slashOptions.length === 0) {
      const target = cursorUpPosition(buffer, cursor, columns);
      if (target !== null) {
        setCursor(target);
        return;
      }
      const scrubbing = draftRef.current !== null;
      const queued =
        queuedRestoreEnabled && buffer.length === 0 && !scrubbing
          ? (onRestoreQueued?.() ?? null)
          : null;
      if (queued !== null) {
        setBufferValue(queued);
        setCursor(queued.length);
        return;
      }
      if (onHistoryPrev === undefined) return;
      // Stash the in-progress draft once, on the first Up that enters history.
      // Empty buffer is stashed as "" so the restore path on Down can return it.
      if (!scrubbing) draftRef.current = buffer;
      const restored = onHistoryPrev(buffer);
      if (restored) {
        setBufferValue(restored.value);
        setCursor(restored.value.length);
        setHistoryPos({ offset: restored.offset, total: restored.total });
        lastRestoredRef.current = restored.value;
      } else if (!scrubbing) {
        // No history at all — release the stash so we don't pretend to scrub.
        draftRef.current = null;
      }
      return;
    }

    if (key.downArrow && slashOptions.length === 0) {
      const target = cursorDownPosition(buffer, cursor, columns);
      if (target !== null) {
        setCursor(target);
        return;
      }
      const restored = onHistoryNext?.(buffer);
      if (restored !== null && restored !== undefined) {
        if (restored.offset === 0) {
          setHistoryPos(null);
          lastRestoredRef.current = null;
          if (draftRef.current !== null) {
            const draft = draftRef.current;
            draftRef.current = null;
            setBufferValue(draft);
            setCursor(draft.length);
            return;
          }
        } else {
          setHistoryPos({ offset: restored.offset, total: restored.total });
          lastRestoredRef.current = restored.value;
        }
        setBufferValue(restored.value);
        setCursor(restored.value.length);
      }
      return;
    }

    if (returnKey) {
      const prefix = newlineIndex >= 0 ? input.slice(0, newlineIndex) : "";
      const nextBuffer = buffer.slice(0, cursor) + prefix + buffer.slice(cursor);
      const selectedSlash = prefix.length === 0 ? slashOptions[autoIdx] : undefined;
      onSubmit(selectedSlash ? `/${selectedSlash.name}` : nextBuffer);
      setBufferValue("");
      setCursor(0);
      setAutoIdx(0);
      draftRef.current = null;
      setHistoryPos(null);
      return;
    }
    if ((key.ctrl || key.meta) && (key.backspace || key.delete)) {
      const start = prevWordBoundary(buffer, cursor);
      if (start === cursor) return;
      setBufferValue(buffer.slice(0, start) + buffer.slice(cursor));
      setCursor(start);
      setAutoIdx(0);
      return;
    }
    if (key.ctrl && input === "w") {
      const start = prevWordBoundary(buffer, cursor);
      if (start === cursor) return;
      setBufferValue(buffer.slice(0, start) + buffer.slice(cursor));
      setCursor(start);
      setAutoIdx(0);
      return;
    }
    if (key.ctrl && input === "u") {
      if (cursor === 0) return;
      setBufferValue(buffer.slice(cursor));
      setCursor(0);
      setAutoIdx(0);
      return;
    }
    if (key.ctrl && input === "k") {
      if (cursor === buffer.length) return;
      setBufferValue(buffer.slice(0, cursor));
      setAutoIdx(0);
      return;
    }
    if (key.meta && input === "d") {
      const end = nextWordBoundary(buffer, cursor);
      if (end === cursor) return;
      setBufferValue(buffer.slice(0, cursor) + buffer.slice(end));
      setAutoIdx(0);
      return;
    }
    if (key.backspace) {
      if (cursor === 0) return;
      const ref = refEndingAt(buffer, cursor);
      if (ref) {
        setBufferValue(buffer.slice(0, ref.start) + buffer.slice(ref.end));
        setCursor(ref.start);
        setAutoIdx(0);
        return;
      }
      {
        const start = prevGraphemeBoundary(buffer, cursor);
        setBufferValue(buffer.slice(0, start) + buffer.slice(cursor));
        setCursor(start);
      }
      setAutoIdx(0);
      return;
    }
    if (key.delete) {
      if (cursor >= buffer.length) return;
      const ref = refStartingAt(buffer, cursor);
      if (ref) {
        setBufferValue(buffer.slice(0, ref.start) + buffer.slice(ref.end));
        setAutoIdx(0);
        return;
      }
      setBufferValue(buffer.slice(0, cursor) + buffer.slice(nextGraphemeBoundary(buffer, cursor)));
      setAutoIdx(0);
      return;
    }
    if (key.leftArrow && (key.ctrl || key.meta)) {
      setCursor(prevWordBoundary(buffer, cursor));
      return;
    }
    if (key.rightArrow && (key.ctrl || key.meta)) {
      setCursor(nextWordBoundary(buffer, cursor));
      return;
    }
    if (key.meta && input === "b") {
      setCursor(prevWordBoundary(buffer, cursor));
      return;
    }
    if (key.meta && input === "f") {
      setCursor(nextWordBoundary(buffer, cursor));
      return;
    }
    if (key.leftArrow || (key.ctrl && input === "b")) {
      setCursor(prevGraphemeBoundary(buffer, cursor));
      return;
    }
    if (key.rightArrow || (key.ctrl && input === "f")) {
      setCursor(nextGraphemeBoundary(buffer, cursor));
      return;
    }
    if (key.home || (key.ctrl && input === "a")) {
      setCursor(0);
      return;
    }
    if (key.end || (key.ctrl && input === "e")) {
      setCursor(buffer.length);
      return;
    }
    if (key.ctrl && input === "h") {
      if (cursor === 0) return;
      const ref = refEndingAt(buffer, cursor);
      if (ref) {
        setBufferValue(buffer.slice(0, ref.start) + buffer.slice(ref.end));
        setCursor(ref.start);
        setAutoIdx(0);
        return;
      }
      {
        const start = prevGraphemeBoundary(buffer, cursor);
        setBufferValue(buffer.slice(0, start) + buffer.slice(cursor));
        setCursor(start);
      }
      setAutoIdx(0);
      return;
    }
    if (input && !key.ctrl && !key.meta) {
      setBufferValue(buffer.slice(0, cursor) + input + buffer.slice(cursor));
      setCursor((c) => c + input.length);
      setAutoIdx(0);
      // Typing means the user is composing a fresh prompt, not browsing history.
      // Drop any stale draftRef stash so the next Up press treats this buffer
      // as the new draft (and the next Down past head restores it correctly).
      draftRef.current = null;
    }
  });

  const displayText = disabled && frozenText !== undefined ? frozenText : buffer;
  const displayCursor = disabled && frozenText !== undefined ? displayText.length : cursor;
  const promptRows = promptDisplayRows(displayText, displayCursor, columns);
  const showQueueHint = promptOwnsInput && queueHint && buffer.length === 0;
  const cursorRow = promptRows.findIndex((row) => row.cursorOffset !== null);
  const cursorColumn = cursorRow >= 0 ? (promptRows[cursorRow]?.cursorOffset ?? 0) : 0;
  const cursorActive = promptOwnsInput && !showQueueHint && cursorRow >= 0;
  const cursorRef = useCursorOwner({
    line: cursorRow >= 0 ? cursorRow : 0,
    column: Glyph.chevron.length + cursorColumn,
    active: cursorActive,
  });

  return (
    <Box flexDirection="column" width="100%">
      <Box position="relative" width="100%">
        <Box
          borderStyle="single"
          borderColor={agentPill !== undefined ? Color.primary : Color.border}
          borderTop
          borderBottom
          borderLeft={false}
          borderRight={false}
          paddingX={0}
          width="100%"
          {...(() => {
            // Pre-colored: the border renderer embeds the string verbatim.
            const content =
              agentPill !== undefined
                ? colorize(
                    colorize(` ${agentPill} `, Color.tabSelectedText, "foreground"),
                    Color.primary,
                    "background",
                  )
                : badgeBorderText({ effortLevel, fastModeActive });
            return content !== undefined
              ? {
                  borderText: {
                    content,
                    position: "top" as const,
                    align: "end" as const,
                    offset: 1,
                  },
                }
              : {};
          })()}
        >
          {showQueueHint ? (
            <Box>
              <Text color={Color.chevron}>{Glyph.chevron}</Text>
              <Text inverse>P</Text>
              <Text color={Color.muted} dim>
                ress up to edit queued messages
              </Text>
            </Box>
          ) : (
            <Box flexDirection="column" width="100%" ref={cursorRef}>
              {promptRows.map((row, index) => {
                const isLastRow = index === promptRows.length - 1;
                const hintAfter =
                  argHint && isLastRow && row.cursorOffset !== null ? argHint : null;
                return (
                  <Box
                    // biome-ignore lint/suspicious/noArrayIndexKey: stable per render
                    key={index}
                    width="100%"
                  >
                    <Text color={Color.chevron}>{index === 0 ? Glyph.chevron : "  "}</Text>
                    {row.cursorOffset === null || !promptOwnsInput ? (
                      <Text color={Color.text}>{row.text}</Text>
                    ) : (
                      <>
                        <Text color={Color.text}>{row.text.slice(0, row.cursorOffset)}</Text>
                        <Text inverse>{row.cursorChar}</Text>
                        <Text color={Color.text}>
                          {row.text.slice(row.cursorOffset + row.cursorChar.length)}
                        </Text>
                        {!!hintAfter && <Text color={Color.subtle}>{hintAfter}</Text>}
                      </>
                    )}
                  </Box>
                );
              })}
            </Box>
          )}
        </Box>
        {historyPos !== null && (
          <Box position="absolute" top={0} left={3}>
            <Text color={Color.muted}>{` History ${historyPos.offset}/${historyPos.total} `}</Text>
          </Box>
        )}
      </Box>
      <Autocomplete
        options={slashOptions}
        selected={autoIdx}
        noMatchQuery={slashNoMatch ? (slashQuery ?? "") : undefined}
      />
    </Box>
  );
}

export function Prompt(props: PromptProps): React.JSX.Element {
  return <PromptImpl {...props} />;
}
