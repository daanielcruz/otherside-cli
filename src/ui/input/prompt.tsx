import { useContext, useEffect, useMemo, useRef, useState } from "react";
import { listCompletions, looksLikeCommand, lookup as lookupSlash } from "@/commands/index.ts";
import { notifyInteractionActivity } from "@/devtools/memory/gc-cadence.ts";
import {
  promptInputModeOf,
  stripBashPrefix,
  withPromptMode,
} from "@/engine/queue/turn/bash-input.ts";
import {
  Box,
  colorize,
  Text,
  TimekeeperContext,
  useCursorOwner,
  useFrameClock,
  useInput,
  useIsTerminalFocused,
  usePaste,
  useTerminalDimensions,
} from "@/ink";
import type { VoiceProviderId } from "@/kernel/config/provider-ids.ts";
import { createAutoClearDispatch } from "@/kernel/std/state/auto-clear-dispatch.ts";
import type { PasteStore } from "@/kernel/std/types/paste.ts";
import { setPromptBashMode, setPromptMenuOpen, setPromptSearch } from "@/store/prompt/index.ts";
import { promptOwnsArrowNavigation } from "@/ui/input/arrow-navigation.ts";
import { Autocomplete } from "@/ui/input/autocomplete.tsx";
import { entersBashMode, exitsBashMode } from "@/ui/input/bash-mode.ts";
import { findHistoryMatch } from "@/ui/input/history-search.ts";
import {
  beginYank,
  interruptKillChain,
  latestKill,
  nextYankPop,
  recordKill,
} from "@/ui/input/kill-ring.ts";
import { readImageFromClipboard } from "@/ui/input/paste/clipboard.ts";
import {
  joinWithLeadingSpace,
  maybeTruncateBuffer,
  normalizePastedText,
  PASTE_THRESHOLD,
  refEndingAt,
  refStartingAt,
  snapOutOfRef,
} from "@/ui/input/paste/references.ts";
import {
  cursorDownPosition,
  cursorUpPosition,
  deleteToVisualLineEnd,
  deleteToVisualLineStart,
  logicalLineEndOffset,
  logicalLineStartOffset,
  nextGraphemeBoundary,
  nextWordBoundary,
  prevGraphemeBoundary,
  prevWordBoundary,
  promptDisplayRows,
  type RowRange,
  splitRowByRange,
  visualLineEndOffset,
  visualLineStartOffset,
} from "@/ui/input/prompt-text.ts";
import { useVoiceInput, type VoicePhase } from "@/ui/input/use-voice-input.ts";
import { effortColor } from "@/ui/theme/effort-color.ts";
import { Color, Glyph } from "@/ui/theme/theme.ts";

export interface HistoryRestoreResult {
  value: string;
  offset: number;
  total: number;
}

export interface VoiceChromeState {
  phase: VoicePhase;
  message: string | null;
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
  voiceProvider?: VoiceProviderId | null;
  language?: string | undefined;
  onVoiceStateChange?: ((state: VoiceChromeState) => void) | undefined;
  emptyDoubleEscapeEnabled?: boolean;
  onEmptyDoubleEscape?: () => void;
  // Dimmed text shown while the buffer is empty (e.g. "Message @agent…").
  placeholder?: string | undefined;
  // Transient editor hint for the status line (e.g. the yank hint).
  onEditorHint?: ((text: string) => void) | undefined;
  // Full history snapshot backing the Ctrl+R reverse search.
  historyEntries?: (() => readonly string[]) | undefined;
}

interface HistorySearchSession {
  query: string;
  failed: boolean;
  original: string;
  originalCursor: number;
  // Continuation cursor into the newest-first scan; null before any match.
  scanIndex: number | null;
  matchOffset: number | null;
}

function RowSpans({
  text,
  rowStart,
  range,
}: {
  text: string;
  rowStart: number;
  range: RowRange | null;
}): React.JSX.Element {
  return (
    <>
      {splitRowByRange(text, rowStart, range).map((span, spanIndex) => (
        <Text
          // biome-ignore lint/suspicious/noArrayIndexKey: stable per render
          key={spanIndex}
          color={span.style === "match" ? Color.warning : Color.text}
          dim={span.style === "dim"}
        >
          {span.text}
        </Text>
      ))}
    </>
  );
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

const VOICE_CURSOR_CHARS = " ▂▃▄▅▆▇█";
const VOICE_SMOOTHING = 0.7;
const VOICE_SCALE = 1.8;
const VOICE_SILENCE_THRESHOLD = 0.15;

function voiceCursorColor(hue: number): `#${string}` {
  const normalizedHue = ((hue % 360) + 360) % 360;
  const chroma = 0.56;
  const x = chroma * (1 - Math.abs(((normalizedHue / 60) % 2) - 1));
  const offset = 0.32;
  let red = 0;
  let green = 0;
  let blue = 0;
  if (normalizedHue < 60) {
    red = chroma;
    green = x;
  } else if (normalizedHue < 120) {
    red = x;
    green = chroma;
  } else if (normalizedHue < 180) {
    green = chroma;
    blue = x;
  } else if (normalizedHue < 240) {
    green = x;
    blue = chroma;
  } else if (normalizedHue < 300) {
    red = x;
    blue = chroma;
  } else {
    red = chroma;
    blue = x;
  }
  const channel = (value: number): number => Math.round((value + offset) * 255);
  return `#${[channel(red), channel(green), channel(blue)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("")}`;
}

function useVoiceCursor(phase: VoicePhase, level: number) {
  const recording = phase === "recording";
  const [ref, time] = useFrameClock(recording ? 50 : null);
  const accumulatedLevel = useRef(0);
  const wasRecording = useRef(false);
  if (recording && !wasRecording.current) accumulatedLevel.current = 0;
  wasRecording.current = recording;
  if (!recording) return [ref, null] as const;

  const normalizedLevel = Math.min(level * VOICE_SCALE, 1);
  accumulatedLevel.current =
    accumulatedLevel.current * VOICE_SMOOTHING + normalizedLevel * (1 - VOICE_SMOOTHING);
  const charIndex = Math.max(
    1,
    Math.min(
      Math.round(accumulatedLevel.current * (VOICE_CURSOR_CHARS.length - 1)),
      VOICE_CURSOR_CHARS.length - 1,
    ),
  );
  return [
    ref,
    {
      char: VOICE_CURSOR_CHARS[charIndex]!,
      color:
        level < VOICE_SILENCE_THRESHOLD
          ? ("#808080" as const)
          : voiceCursorColor((time / 1000) * 90),
    },
  ] as const;
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
  voiceProvider = null,
  language,
  onVoiceStateChange,
  emptyDoubleEscapeEnabled = true,
  onEmptyDoubleEscape,
  placeholder,
  onEditorHint,
  historyEntries,
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
  const [search, setSearch] = useState<HistorySearchSession | null>(null);
  // `!` bash input mode. The buffer holds the bare command; the `!` prefix is
  // applied on submit and when talking to history (its storage form), so the
  // mode survives round-trips without living in the text itself.
  const [bashMode, setBashModeState] = useState(false);
  const bashModeRef = useRef(false);
  const setBashMode = (on: boolean): void => {
    bashModeRef.current = on;
    setBashModeState(on);
    setPromptBashMode(on);
  };
  useEffect(() => {
    return () => setPromptBashMode(false);
  }, []);

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

  // Apply a history/queue value in its storage form: a `!`-prefixed entry
  // re-enters bash mode with the bare command; anything else leaves it.
  // Returns the text that landed in the buffer.
  const applyStoredValue = (stored: string): string => {
    setBashMode(promptInputModeOf(stored) === "bash");
    const text = stripBashPrefix(stored);
    setBufferValue(text);
    setCursor(text.length);
    return text;
  };

  const searchStateRef = useRef<HistorySearchSession | null>(null);
  searchStateRef.current = search;

  const updateSearch = (next: HistorySearchSession | null): void => {
    searchStateRef.current = next;
    setSearch(next);
    setPromptSearch(next === null ? null : { query: next.query, failed: next.failed });
  };

  useEffect(() => {
    return () => setPromptSearch(null);
  }, []);

  // Re-run the search for a query; a repeat (Ctrl+R) passes the scan index
  // after the current match so the walk continues toward older entries.
  const applySearchQuery = (
    session: HistorySearchSession,
    query: string,
    fromScanIndex: number,
  ): void => {
    if (query.length === 0) {
      updateSearch({ ...session, query, failed: false, scanIndex: null, matchOffset: null });
      setBufferValue(session.original);
      setCursor(session.originalCursor);
      return;
    }
    const match = findHistoryMatch(historyEntries?.() ?? [], query, fromScanIndex);
    if (match === null) {
      // No match: keep the last displayed match, flag the search bar.
      updateSearch({ ...session, query, failed: true });
      return;
    }
    updateSearch({
      ...session,
      query,
      failed: false,
      scanIndex: match.scanIndex,
      matchOffset: match.matchOffset,
    });
    setBufferValue(match.value);
    setCursor(match.matchOffset);
  };

  const submitFromSearch = (text: string): void => {
    onSubmit(text);
    setBufferValue("");
    setCursor(0);
    setAutoIdx(0);
    draftRef.current = null;
    setHistoryPos(null);
  };

  const handleSearchKey = (input: string, key: Parameters<Parameters<typeof useInput>[0]>[1]) => {
    const session = searchStateRef.current;
    if (session === null) return;
    if (key.ctrl && input === "r") {
      applySearchQuery(session, session.query, (session.scanIndex ?? -1) + 1);
      return;
    }
    if (key.ctrl && input === "c") {
      updateSearch(null);
      setBufferValue(session.original);
      setCursor(session.originalCursor);
      return;
    }
    if (key.escape || key.tab) {
      // Accept: the buffer already displays the match.
      updateSearch(null);
      return;
    }
    if (key.return) {
      updateSearch(null);
      if (session.query.length === 0) submitFromSearch(session.original);
      else if (!session.failed && session.matchOffset !== null)
        submitFromSearch(latestBufferRef.current);
      return;
    }
    if (key.backspace || (key.ctrl && input === "h")) {
      if (session.query.length === 0) {
        updateSearch(null);
        setBufferValue(session.original);
        setCursor(session.originalCursor);
        return;
      }
      applySearchQuery(session, session.query.slice(0, -1), 0);
      return;
    }
    if (input.length > 0 && !key.ctrl && !key.meta) {
      applySearchQuery(session, session.query + input.normalize("NFC"), 0);
    }
  };

  const voice = useVoiceInput({
    provider: voiceProvider,
    ...(language !== undefined ? { language } : {}),
    bufferRef: latestBufferRef,
    cursorRef: latestCursorRef,
    setBuffer: setBufferValue,
    setCursor,
    onSubmit,
    suspended: inputSuspended,
  });
  useEffect(() => {
    onVoiceStateChange?.({ phase: voice.state.phase, message: voice.state.message });
  }, [onVoiceStateChange, voice.state.message, voice.state.phase]);

  const slashQuery =
    buffer.startsWith("/") && !disabled && !bashMode && historyPos === null
      ? buffer.slice(1)
      : null;
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
      const normalized = normalizePastedText(pasted);
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

    // An open history search owns the keyboard until accepted or cancelled;
    // consuming the event keeps the same keystroke from reaching the global
    // cancel ladder after the search state closes.
    if (searchStateRef.current !== null) {
      handleSearchKey(input, key);
      event.stopImmediatePropagation();
      return;
    }

    if (voice.handleKey(input, key, slashOptions.length > 0)) return;

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

    // Esc at offset 0 leaves bash mode and nothing else: consuming the event
    // keeps the same keystroke off the global cancel ladder and the
    // double-escape rewind below.
    if (key.escape && exitsBashMode({ cursor, bashMode: bashModeRef.current })) {
      setBashMode(false);
      event.stopImmediatePropagation();
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

    // Consecutive kills accumulate into one ring entry and Alt+Y cycles only
    // right after a yank; any other key breaks both chains.
    const isKillKey =
      (key.ctrl && (input === "k" || input === "u" || input === "w")) ||
      ((key.ctrl || key.meta) && key.backspace) ||
      (key.meta && key.delete);
    const isYankKey = (key.ctrl || key.meta) && input === "y";
    if (!isKillKey && !isYankKey) interruptKillChain();

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

    if ((key.upArrow || (key.ctrl && input === "p")) && slashOptions.length === 0) {
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
        applyStoredValue(queued);
        return;
      }
      if (onHistoryPrev === undefined) return;
      // History speaks the storage form: bash-mode buffers travel `!`-prefixed
      // so the nav can filter by mode and recalled entries carry theirs back.
      const storedBuffer = withPromptMode(buffer, bashModeRef.current ? "bash" : "prompt");
      // Stash the in-progress draft once, on the first Up that enters history.
      // Empty buffer is stashed as "" so the restore path on Down can return it.
      if (!scrubbing) draftRef.current = storedBuffer;
      const restored = onHistoryPrev(storedBuffer);
      if (restored) {
        const restoredText = applyStoredValue(restored.value);
        setHistoryPos({ offset: restored.offset, total: restored.total });
        lastRestoredRef.current = restoredText;
      } else if (!scrubbing) {
        // No history at all — release the stash so we don't pretend to scrub.
        draftRef.current = null;
      }
      return;
    }

    if ((key.downArrow || (key.ctrl && input === "n")) && slashOptions.length === 0) {
      const target = cursorDownPosition(buffer, cursor, columns);
      if (target !== null) {
        setCursor(target);
        return;
      }
      const restored = onHistoryNext?.(
        withPromptMode(buffer, bashModeRef.current ? "bash" : "prompt"),
      );
      if (restored !== null && restored !== undefined) {
        if (restored.offset === 0) {
          setHistoryPos(null);
          lastRestoredRef.current = null;
          if (draftRef.current !== null) {
            const draft = draftRef.current;
            draftRef.current = null;
            applyStoredValue(draft);
            return;
          }
        } else {
          setHistoryPos({ offset: restored.offset, total: restored.total });
        }
        const restoredText = applyStoredValue(restored.value);
        if (restored.offset !== 0) lastRestoredRef.current = restoredText;
      }
      return;
    }

    if (key.return || event.keypress.sequence === "\x1bOM") {
      // A trailing backslash before the cursor turns Enter into a newline,
      // consuming the backslash.
      if (cursor > 0 && buffer[cursor - 1] === "\\") {
        setBufferValue(`${buffer.slice(0, cursor - 1)}\n${buffer.slice(cursor)}`);
        setAutoIdx(0);
        draftRef.current = null;
        return;
      }
      // Shift+Enter, Meta+Enter, and keypad enter insert a newline.
      if (key.shift || key.meta || event.keypress.sequence === "\x1bOM") {
        setBufferValue(`${buffer.slice(0, cursor)}\n${buffer.slice(cursor)}`);
        setCursor(cursor + 1);
        setAutoIdx(0);
        draftRef.current = null;
        return;
      }
    }
    if (returnKey) {
      const prefix = newlineIndex >= 0 ? input.slice(0, newlineIndex) : "";
      const nextBuffer = buffer.slice(0, cursor) + prefix + buffer.slice(cursor);
      const selectedSlash = prefix.length === 0 ? slashOptions[autoIdx] : undefined;
      if (bashModeRef.current) {
        // A bash-mode submission travels in its storage form (`!command`);
        // an empty command has nothing to run.
        if (nextBuffer.trim().length === 0) return;
        onSubmit(withPromptMode(nextBuffer, "bash"));
        setBashMode(false);
      } else {
        onSubmit(selectedSlash ? `/${selectedSlash.name}` : nextBuffer);
      }
      setBufferValue("");
      setCursor(0);
      setAutoIdx(0);
      draftRef.current = null;
      setHistoryPos(null);
      return;
    }
    if (key.meta && key.delete) {
      if (cursor === buffer.length) return;
      const edit = deleteToVisualLineEnd(buffer, cursor, columns);
      recordKill(edit.killed, "append");
      setBufferValue(edit.text);
      setCursor(edit.cursor);
      setAutoIdx(0);
      return;
    }
    if (((key.ctrl || key.meta) && key.backspace) || (key.ctrl && input === "w")) {
      const start = snapOutOfRef(buffer, prevWordBoundary(buffer, cursor), "start");
      if (start === cursor) return;
      recordKill(buffer.slice(start, cursor), "prepend");
      setBufferValue(buffer.slice(0, start) + buffer.slice(cursor));
      setCursor(start);
      setAutoIdx(0);
      return;
    }
    if (key.ctrl && input === "u") {
      if (cursor === 0) return;
      const edit = deleteToVisualLineStart(buffer, cursor, columns);
      recordKill(edit.killed, "prepend");
      if (edit.killed.length >= 3) onEditorHint?.("Ctrl+Y to paste deleted text");
      setBufferValue(edit.text);
      setCursor(edit.cursor);
      setAutoIdx(0);
      return;
    }
    if (key.ctrl && input === "k") {
      if (cursor === buffer.length) return;
      const edit = deleteToVisualLineEnd(buffer, cursor, columns);
      recordKill(edit.killed, "append");
      setBufferValue(edit.text);
      setCursor(edit.cursor);
      setAutoIdx(0);
      return;
    }
    if (key.ctrl && input === "r" && historyEntries !== undefined) {
      updateSearch({
        query: "",
        failed: false,
        original: buffer,
        originalCursor: cursor,
        scanIndex: null,
        matchOffset: null,
      });
      return;
    }
    if (key.ctrl && input === "y") {
      const killed = latestKill();
      if (killed.length === 0) return;
      beginYank(cursor, killed.length);
      setBufferValue(buffer.slice(0, cursor) + killed + buffer.slice(cursor));
      setCursor(cursor + killed.length);
      setAutoIdx(0);
      return;
    }
    if (key.meta && input === "y") {
      const pop = nextYankPop();
      if (pop === null) return;
      setBufferValue(buffer.slice(0, pop.start) + pop.text + buffer.slice(pop.start + pop.length));
      setCursor(pop.start + pop.text.length);
      setAutoIdx(0);
      return;
    }
    if (key.ctrl && input === "d") {
      if (buffer.length === 0) return;
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
    if (key.meta && input === "d") {
      const end = snapOutOfRef(buffer, nextWordBoundary(buffer, cursor), "end");
      if (end === cursor) return;
      setBufferValue(buffer.slice(0, cursor) + buffer.slice(end));
      setAutoIdx(0);
      return;
    }
    if (key.backspace) {
      if (cursor === 0) {
        // Backspace at offset 0 rubs out the mode indicator itself.
        if (exitsBashMode({ cursor, bashMode: bashModeRef.current })) setBashMode(false);
        return;
      }
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
    if (key.home) {
      setCursor(visualLineStartOffset(buffer, cursor, columns));
      return;
    }
    if (key.end) {
      setCursor(visualLineEndOffset(buffer, cursor, columns));
      return;
    }
    if (key.ctrl && input === "a") {
      setCursor(logicalLineStartOffset(buffer, cursor));
      return;
    }
    if (key.ctrl && input === "e") {
      setCursor(logicalLineEndOffset(buffer, cursor));
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
      if (entersBashMode({ key: input, buffer, cursor, bashMode: bashModeRef.current })) {
        setBashMode(true);
        return;
      }
      const insert = input.normalize("NFC");
      setBufferValue(buffer.slice(0, cursor) + insert + buffer.slice(cursor));
      setCursor((c) => c + insert.length);
      setAutoIdx(0);
      // Typing means the user is composing a fresh prompt, not browsing history.
      // Drop any stale draftRef stash so the next Up press treats this buffer
      // as the new draft (and the next Down past head restores it correctly).
      draftRef.current = null;
    }
  });

  const displayText =
    disabled && frozenText !== undefined ? frozenText : (voice.state.preview?.text ?? buffer);
  const displayCursor =
    disabled && frozenText !== undefined
      ? displayText.length
      : (voice.state.preview?.cursor ?? cursor);
  const promptRows = promptDisplayRows(displayText, displayCursor, columns);
  // Interim dictation renders dim so it reads as provisional; the range ends
  // at the cursor, so it never crosses the cursor cell. An active history
  // search instead highlights the matched query span.
  const voicePreview = disabled ? null : voice.state.preview;
  const searchOpen = search !== null;
  const searchMatchRange =
    search !== null && !search.failed && search.matchOffset !== null && search.query.length > 0
      ? {
          start: search.matchOffset,
          end: search.matchOffset + search.query.length,
          style: "match" as const,
        }
      : null;
  const interimRange =
    voicePreview && voicePreview.cursor > voicePreview.transcriptStart
      ? { start: voicePreview.transcriptStart, end: voicePreview.cursor, style: "dim" as const }
      : null;
  const rowRange = searchMatchRange ?? interimRange;
  const showPlaceholder =
    promptOwnsInput &&
    !bashMode &&
    placeholder !== undefined &&
    placeholder.length > 0 &&
    buffer.length === 0;
  const showQueueHint =
    promptOwnsInput && !bashMode && !showPlaceholder && queueHint && buffer.length === 0;
  const promptGlyph = bashMode ? "!\u00A0" : Glyph.promptChevron;
  const promptGlyphColor = bashMode ? Color.bashMode : Color.chevron;
  const cursorRow = promptRows.findIndex((row) => row.cursorOffset !== null);
  const cursorColumn = cursorRow >= 0 ? (promptRows[cursorRow]?.cursorColumn ?? 0) : 0;
  const cursorActive =
    promptOwnsInput && !showQueueHint && !showPlaceholder && !searchOpen && cursorRow >= 0;
  const [voiceCursorRef, voiceCursor] = useVoiceCursor(voice.state.phase, voice.state.level);
  const cursorRef = useCursorOwner({
    line: cursorRow >= 0 ? cursorRow : 0,
    column: Glyph.promptChevron.length + cursorColumn,
    active: cursorActive,
  });

  return (
    <Box flexDirection="column" width="100%" ref={voiceCursorRef}>
      <Box position="relative" width="100%">
        <Box
          borderStyle="single"
          borderColor={
            bashMode ? Color.bashMode : agentPill !== undefined ? Color.primary : Color.border
          }
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
          {showPlaceholder ? (
            <Box>
              <Text color={Color.chevron}>{Glyph.promptChevron}</Text>
              <Text inverse>{placeholder?.slice(0, 1)}</Text>
              <Text color={Color.muted} dim>
                {placeholder?.slice(1)}
              </Text>
            </Box>
          ) : showQueueHint ? (
            <Box>
              <Text color={Color.chevron}>{Glyph.promptChevron}</Text>
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
                    <Text color={promptGlyphColor}>{index === 0 ? promptGlyph : "  "}</Text>
                    {row.cursorOffset === null || !promptOwnsInput || searchOpen ? (
                      <RowSpans text={row.text} rowStart={row.start} range={rowRange} />
                    ) : (
                      <>
                        <RowSpans
                          text={row.text.slice(0, row.cursorOffset)}
                          rowStart={row.start}
                          range={rowRange}
                        />
                        {voiceCursor ? (
                          <Text color={voiceCursor.color}>{voiceCursor.char}</Text>
                        ) : (
                          <Text inverse>{row.cursorChar}</Text>
                        )}
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
