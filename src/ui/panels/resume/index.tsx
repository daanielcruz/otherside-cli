import { memo, useEffect, useMemo, useRef, useState } from "react";
import { appendCustomTitleToPath } from "@/engine/session/index.ts";
import {
  listSessionFileStats,
  listSlugSessionFileStats,
  sessionCwdFilterFor,
  sessionCwdFilterSeed,
} from "@/engine/session/paths.ts";
import { loadSessionForResume } from "@/engine/session/persist.ts";
import { liveSessionsForCwd } from "@/engine/session/registry.ts";
import { Box, Text, useTerminalDimensions } from "@/ink";
import { errorMessage } from "@/kernel/std/errno.ts";
import { formatBytes } from "@/kernel/std/text/format.ts";
import { FooterPanel, FooterPanelPickerRow } from "@/ui/chrome/panel.tsx";
import { usePanelNavigation } from "@/ui/hooks/use-panel-navigation.ts";
import {
  type ResumeMode,
  resumeKeyAction,
  submitResumeSelection,
} from "@/ui/panels/resume/controller";
import {
  applyOutcomes,
  clip,
  enrichSlice,
  formatRelative,
  isListedEntry,
  LABEL_CLIP_CHARS,
  labelFor,
  liteEntryFrom,
  mergeStatRows,
  metaTextFor,
  type PreviewState,
  previewLinesFromRecords,
  resumeMaxHeight,
  type SessionEntry,
  searchTextFor,
  visibleResumeRows,
} from "@/ui/panels/resume/entries";
import { useOverlayClose } from "@/ui/panels/use-overlay-close";
import { Color } from "@/ui/theme/theme.ts";

const LIST_HINTS: [string, string][] = [
  ["Type", "search"],
  ["Space", "preview"],
  ["Ctrl+R", "rename"],
  ["Enter", "resume"],
  ["Esc", "cancel"],
];
const SEARCH_HINTS: [string, string][] = [
  ["Enter", "select"],
  ["Esc", "clear"],
];
const RENAME_HINTS: [string, string][] = [
  ["Enter", "save"],
  ["Esc", "cancel"],
];
const PREVIEW_HINTS: [string, string][] = [
  ["Enter", "resume"],
  ["↑↓", "scroll"],
  ["Esc", "back"],
];

export interface ResumeOverlayProps {
  onResumeSession?: (id: string) => void | Promise<void>;
  onClose?: () => void;
}

export function ResumeOverlay({
  onResumeSession,
  onClose,
}: ResumeOverlayProps = {}): React.JSX.Element {
  const close = useOverlayClose(onClose);
  const { rows: terminalRows } = useTerminalDimensions();
  const seedFilter = useMemo(() => sessionCwdFilterSeed(process.cwd()), []);
  const [cwdFilter, setCwdFilter] = useState(seedFilter);
  const [statRows, setStatRows] = useState(() => listSlugSessionFileStats(seedFilter));
  const [entries, setEntries] = useState<SessionEntry[]>(() => statRows.map(liteEntryFrom));
  const enrichRef = useRef({ nextIndex: 0, running: false });
  const aliveRef = useRef(true);
  useEffect(() => {
    return () => {
      aliveRef.current = false;
    };
  }, []);
  useEffect(() => {
    void (async () => {
      const filter = await sessionCwdFilterFor(process.cwd());
      const rows = await listSessionFileStats(filter);
      if (!aliveRef.current) return;
      setCwdFilter(filter);
      setStatRows(rows);
      setEntries((prev) => mergeStatRows(prev, rows));
    })();
  }, []);
  const liveIds = useMemo(
    () => new Set(liveSessionsForCwd(process.cwd()).map((entry) => entry.sessionId)),
    [],
  );
  const [query, setQuery] = useState("");
  const [idx, setIdx] = useState(0);
  const [mode, setMode] = useState<ResumeMode>("list");
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [previewScroll, setPreviewScroll] = useState(0);
  const [rename, setRename] = useState<{ id: string; path: string; value: string } | null>(null);
  const [resumeError, setResumeError] = useState<string | null>(null);

  const allSessions = useMemo(() => entries.filter(isListedEntry), [entries]);
  const sessions = useMemo(() => {
    const q = foldText(query);
    if (q.length === 0) return allSessions;
    return allSessions.filter((session) => foldText(searchTextFor(session)).includes(q));
  }, [allSessions, query]);

  const cwdLabel = basenameOfCwd(process.cwd());
  const hints =
    mode === "rename"
      ? RENAME_HINTS
      : mode === "search"
        ? SEARCH_HINTS
        : mode === "preview"
          ? PREVIEW_HINTS
          : LIST_HINTS;
  const maxHeight = resumeMaxHeight(terminalRows);
  const visibleRows = visibleResumeRows(terminalRows);

  useEffect(() => {
    setIdx((current) => Math.min(Math.max(0, sessions.length - 1), current));
  }, [sessions.length, visibleRows]);

  const openPreview = (entry: SessionEntry): void => {
    setPreview({ id: entry.id, updatedAt: entry.updatedAt, lines: [], loading: true });
    setPreviewScroll(0);
    setMode("preview");
    void loadSessionForResume(entry.id)
      .then((loaded) => {
        if (!aliveRef.current) return;
        setPreview((p) =>
          p && p.id === entry.id
            ? { ...p, lines: previewLinesFromRecords(loaded.records), loading: false }
            : p,
        );
      })
      .catch((error: unknown) => {
        // The resume loader refuses sessions from another directory; surface
        // that refusal inside the preview instead of a silent empty pane.
        if (!aliveRef.current) return;
        setPreview((p) =>
          p && p.id === entry.id ? { ...p, loading: false, error: errorMessage(error) } : p,
        );
      });
  };

  const submitRename = (): void => {
    if (!rename) return;
    const trimmed = rename.value.trim();
    const { id, path } = rename;
    setRename(null);
    setMode("list");
    if (trimmed.length === 0) return;
    setEntries((prev) =>
      prev.map((entry) =>
        entry.id === id && entry.phase === "enriched" ? { ...entry, title: trimmed } : entry,
      ),
    );
    void appendCustomTitleToPath(path, id, trimmed).catch(() => {});
  };

  const resumeSelected = (id: string | undefined): void => {
    if (id === undefined || !onResumeSession) return;
    setResumeError(null);
    void submitResumeSelection(id, onResumeSession, close).then(setResumeError);
  };

  usePanelNavigation({
    onClose: close,
    skipEsc: true,
    onKey: (input, key) => {
      const action = resumeKeyAction(mode, input, key, {
        selectedIndex: idx,
        queryLength: query.length,
      });
      switch (action.type) {
        case "none":
          return false;
        case "close":
          close();
          return true;
        case "enter-search":
          setMode("search");
          if (action.seed.length > 0) setQuery((q) => q + action.seed);
          setIdx(0);
          return true;
        case "clear-search":
          setQuery("");
          setIdx(0);
          return true;
        case "search-append":
          setQuery((q) => q + action.text);
          setIdx(0);
          return true;
        case "search-delete":
          setQuery((q) => q.slice(0, -1));
          setIdx(0);
          return true;
        case "back-to-list":
          setMode("list");
          setPreview(null);
          setRename(null);
          setIdx(0);
          return true;
        case "move":
          setIdx((i) => Math.max(0, Math.min(Math.max(0, sessions.length - 1), i + action.delta)));
          return true;
        case "page":
          setIdx((i) =>
            Math.max(0, Math.min(Math.max(0, sessions.length - 1), i + action.delta * visibleRows)),
          );
          return true;
        case "preview": {
          const selected = sessions[idx];
          if (selected) openPreview(selected);
          return true;
        }
        case "preview-scroll":
          setPreviewScroll((s) => Math.max(0, s + action.delta));
          return true;
        case "preview-page":
          setPreviewScroll((s) => Math.max(0, s + action.delta * visibleRows));
          return true;
        case "enter-rename": {
          const selected = sessions[idx];
          if (selected) {
            setRename({ id: selected.id, path: selected.path, value: "" });
            setMode("rename");
          }
          return true;
        }
        case "rename-append":
          setRename((r) => (r ? { ...r, value: r.value + action.text } : r));
          return true;
        case "rename-delete":
          setRename((r) => (r ? { ...r, value: r.value.slice(0, -1) } : r));
          return true;
        case "rename-save":
          submitRename();
          return true;
        case "resume":
          resumeSelected(mode === "preview" ? preview?.id : sessions[idx]?.id);
          return true;
      }
    },
  });

  const firstVisible = Math.max(
    0,
    Math.min(idx - Math.floor(visibleRows / 2), sessions.length - visibleRows),
  );
  const lastVisible = Math.min(sessions.length, firstVisible + visibleRows);
  const visible = sessions.slice(firstVisible, lastVisible);
  const showTopArrow = firstVisible > 0;
  const showBottomArrow = lastVisible < sessions.length;
  const showCounter = sessions.length > visibleRows || sessions.length === 0;
  const counterText =
    sessions.length > 0
      ? `(${Math.min(idx + 1, sessions.length)} of ${sessions.length})`
      : `(0 of ${allSessions.length})`;

  useEffect(() => {
    const progress = enrichRef.current;
    if (progress.running || progress.nextIndex >= statRows.length) return;
    const windowHasLite = visible.some((row) => row.phase === "lite");
    const searching = query.length > 0;
    if (progress.nextIndex > 0 && !windowHasLite && !searching) return;
    progress.running = true;
    enrichSlice({
      rows: statRows,
      startIndex: progress.nextIndex,
      filter: cwdFilter,
      onFlush: (outcomes) => {
        if (!aliveRef.current) return;
        setEntries((prev) => applyOutcomes(prev, outcomes));
      },
    })
      .then((nextIndex) => {
        progress.nextIndex = nextIndex;
        progress.running = false;
      })
      .catch(() => {
        progress.running = false;
      });
  });

  const previewRows = visibleRows * 2;
  const titleNode = (
    <Box>
      <Text color={Color.primaryGlow} bold>
        {mode === "preview" ? "Preview session" : "Resume session"}
      </Text>
      {mode !== "preview" && showCounter && <Text color={Color.muted}> {counterText}</Text>}
    </Box>
  );

  if (mode === "preview" && preview) {
    return (
      <FooterPanel title={titleNode} footerHints={PREVIEW_HINTS} disableCancelKey>
        {resumeError !== null && <Text color={Color.error}>{resumeError}</Text>}
        <SessionPreviewView preview={preview} scroll={previewScroll} maxRows={previewRows} />
      </FooterPanel>
    );
  }

  return (
    <FooterPanel
      title={titleNode}
      search={{ query, placeholder: "Search…", focused: mode === "search" }}
      footerHints={hints}
      disableCancelKey
    >
      {resumeError !== null && <Text color={Color.error}>{resumeError}</Text>}
      {sessions.length === 0 ? (
        <Text color={Color.muted}>
          {query.length > 0 ? `No sessions match "${query}".` : "no saved sessions"}
        </Text>
      ) : (
        <Box flexDirection="column" maxHeight={maxHeight} overflow="hidden">
          {cwdLabel !== null && (
            <Box marginBottom={1}>
              <Text color={Color.muted}>{cwdLabel}</Text>
            </Box>
          )}
          {visible.map((s, i) => (
            <SessionRow
              key={s.id}
              session={s}
              selected={mode === "list" && firstVisible + i === idx}
              live={liveIds.has(s.id)}
              scrollUp={i === 0 && showTopArrow}
              scrollDown={i === visible.length - 1 && showBottomArrow}
              renaming={rename?.id === s.id && mode === "rename" ? rename.value : null}
            />
          ))}
        </Box>
      )}
    </FooterPanel>
  );
}

function rowMarker(selected: boolean, scrollDown: boolean, scrollUp: boolean): string {
  if (selected) return "❯ ";
  if (scrollDown) return "↓ ";
  if (scrollUp) return "↑ ";
  return "  ";
}

const SessionRow = memo(function SessionRow({
  session,
  selected,
  live,
  scrollUp,
  scrollDown,
  renaming,
}: {
  session: SessionEntry;
  selected: boolean;
  live: boolean;
  scrollUp: boolean;
  scrollDown: boolean;
  renaming: string | null;
}): React.JSX.Element {
  const previewLabel = labelFor(session);
  const meta = metaTextFor(session, formatBytes(session.sizeBytes));
  const marker = rowMarker(selected, scrollDown, scrollUp);
  const label =
    renaming === null ? (
      previewLabel
    ) : (
      <Text color={Color.highlight} bold>
        {renaming.length > 0 ? renaming : previewLabel}▏
      </Text>
    );
  const description = (
    <Text color={Color.muted} wrap="truncate-end">
      {meta}
      {live && <Text color={Color.warning}>{"  ● live elsewhere"}</Text>}
    </Text>
  );
  return (
    <FooterPanelPickerRow
      label={label}
      description={description}
      selected={selected}
      marker={marker}
      labelBold
    />
  );
});

function SessionPreviewView({
  preview,
  scroll,
  maxRows,
}: {
  preview: PreviewState;
  scroll: number;
  maxRows: number;
}): React.JSX.Element {
  const header = `${metaHeaderFor(preview)} `;
  if (preview.loading) {
    return <Text color={Color.muted}>Loading session…</Text>;
  }
  if (preview.error !== undefined) {
    return (
      <Box flexDirection="column">
        <Text color={Color.error}>{preview.error}</Text>
      </Box>
    );
  }
  if (preview.lines.length === 0) {
    return (
      <Box flexDirection="column">
        <Text color={Color.muted}>{header}</Text>
        <Text color={Color.muted}>No messages to preview.</Text>
      </Box>
    );
  }
  const maxScroll = Math.max(0, preview.lines.length - maxRows);
  const start = Math.min(Math.max(0, scroll), maxScroll);
  const window = preview.lines.slice(start, start + maxRows);
  return (
    <Box flexDirection="column">
      <Text color={Color.muted}>{header}</Text>
      {start > 0 && <Text color={Color.muted}>↑ {start} more above</Text>}
      {window.map((line) => (
        <Box key={line.key}>
          <Text color={line.role === "user" ? Color.highlight : Color.muted}>
            {line.role === "user" ? "❯ " : "  "}
          </Text>
          <Text color={line.role === "user" ? Color.text : Color.muted}>
            {clip(line.text.replace(/\s+/g, " "), LABEL_CLIP_CHARS)}
          </Text>
        </Box>
      ))}
      {start + maxRows < preview.lines.length && (
        <Text color={Color.muted}>↓ {preview.lines.length - (start + maxRows)} more below</Text>
      )}
    </Box>
  );
}

function metaHeaderFor(preview: PreviewState): string {
  const count = preview.lines.length;
  return `${formatRelative(preview.updatedAt)} · ${count} message${count === 1 ? "" : "s"}`;
}

function basenameOfCwd(cwd: string): string | null {
  const trimmed = cwd.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  if (idx === -1) return null;
  const name = trimmed.slice(idx + 1);
  return name.length > 0 ? name : null;
}

function foldText(value: string): string {
  return value
    .trim()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
}
