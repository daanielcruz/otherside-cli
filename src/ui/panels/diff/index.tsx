import { useEffect, useMemo, useState } from "react";
import { Box, Text, useTerminalDimensions } from "@/ink";
import { FooterPanel, FooterPanelRow } from "@/ui/chrome/panel.tsx";
import { usePanelNavigation } from "@/ui/hooks/use-panel-navigation.ts";
import { useOverlayClose } from "@/ui/panels/use-overlay-close";
import { Color } from "@/ui/theme/theme.ts";
import { renderDiffLines } from "@/ui/transcript/tool-render/index.tsx";

export interface DiffOverlayProps {
  onClose?: () => void;
}

export interface DiffSnapshot {
  ok: boolean;
  branch: string;
  status: string[];
  stat: string[];
  patch: string[];
  error?: string;
}

type DiffTab = "summary" | "patch";

const TABS = [{ label: "Summary" }, { label: "Patch" }];

function renderDiffBody(
  snapshot: DiffSnapshot | null,
  tab: DiffTab,
  scroll: number,
): React.JSX.Element {
  if (snapshot === null) return <Text color={Color.muted}>loading git diff</Text>;
  if (tab === "summary") return <DiffSummary snapshot={snapshot} />;
  return <DiffPatch snapshot={snapshot} scroll={scroll} />;
}

export function DiffOverlay({ onClose }: DiffOverlayProps = {}): React.JSX.Element {
  const close = useOverlayClose(onClose);
  const [tab, setTab] = useState<DiffTab>("summary");
  const [scroll, setScroll] = useState(0);
  const [snapshot, setSnapshot] = useState<DiffSnapshot | null>(null);

  const refresh = (): void => {
    setSnapshot(null);
    void collectGitDiff().then((next) => {
      setSnapshot(next);
      setScroll(0);
    });
  };

  useEffect(() => {
    setSnapshot(null);
    void collectGitDiff().then((next) => {
      setSnapshot(next);
      setScroll(0);
    });
  }, []);

  usePanelNavigation({
    onClose: close,
    onKey: (input, key) => {
      if (input === "q") {
        close();
        return true;
      }
      if (key.leftArrow || key.rightArrow) {
        setTab((t) => (t === "summary" ? "patch" : "summary"));
        setScroll(0);
        return true;
      }
      if (key.upArrow) {
        setScroll((n) => Math.max(0, n - 1));
        return true;
      }
      if (key.downArrow) {
        setScroll((n) => n + 1);
        return true;
      }
      if (input === "r") {
        refresh();
        return true;
      }
      return false;
    },
  });

  return (
    <FooterPanel
      command="/diff"
      title="Diff"
      onCancel={close}
      tabs={TABS}
      activeTab={tab === "summary" ? 0 : 1}
      tabsFocused
      footerHints={[
        ["←/→", "switch tabs"],
        ["↑↓", "scroll"],
        ["r", "refresh"],
        ["Esc", "close"],
      ]}
    >
      {renderDiffBody(snapshot, tab, scroll)}
    </FooterPanel>
  );
}

function DiffSummary({ snapshot }: { snapshot: DiffSnapshot }): React.JSX.Element {
  if (!snapshot.ok)
    return <Text color={Color.error}>{snapshot.error ?? "git diff unavailable"}</Text>;
  const changed = snapshot.status.length;
  return (
    <Box flexDirection="column">
      <FooterPanelRow label="Branch" value={snapshot.branch} width={18} />
      <FooterPanelRow label="Changed files" value={String(changed)} width={18} />
      <Box flexDirection="column" marginTop={1}>
        {snapshot.status.length === 0 ? (
          <Text color={Color.muted}>working tree clean</Text>
        ) : (
          snapshot.status.slice(0, 14).map((line) => (
            <Text key={line} color={Color.text}>
              {line}
            </Text>
          ))
        )}
      </Box>
      {snapshot.stat.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          {snapshot.stat.slice(0, 8).map((line) => (
            <Text key={line} color={Color.muted}>
              {line}
            </Text>
          ))}
        </Box>
      )}
    </Box>
  );
}

function DiffPatch({
  snapshot,
  scroll,
}: {
  snapshot: DiffSnapshot;
  scroll: number;
}): React.JSX.Element {
  const { columns } = useTerminalDimensions();
  const patchText = snapshot.patch.join("\n");
  const rows = useMemo(
    () => renderDiffLines(patchText, Math.max(40, columns - 8)),
    [patchText, columns],
  );

  if (!snapshot.ok)
    return <Text color={Color.error}>{snapshot.error ?? "git diff unavailable"}</Text>;
  if (snapshot.patch.length === 0) return <Text color={Color.muted}>no unstaged patch</Text>;
  const visible = rows.slice(scroll, scroll + 18);
  return <Box flexDirection="column">{visible.map((row) => row.element)}</Box>;
}

export async function collectGitDiff(cwd = process.cwd()): Promise<DiffSnapshot> {
  const inside = await runGit(["rev-parse", "--is-inside-work-tree"], cwd);
  if (inside.exit !== 0 || inside.stdout.trim() !== "true") {
    return {
      ok: false,
      branch: "",
      status: [],
      stat: [],
      patch: [],
      error: "not inside a git repository",
    };
  }
  const [branch, status, stat, patch] = await Promise.all([
    runGit(["branch", "--show-current"], cwd),
    runGit(["status", "--short"], cwd),
    runGit(["diff", "--stat", "--color=never"], cwd),
    runGit(["diff", "--color=never", "--"], cwd),
  ]);
  return {
    ok: true,
    branch: branch.stdout.trim() || "(detached)",
    status: lines(status.stdout),
    stat: lines(stat.stdout),
    patch: lines(patch.stdout).slice(0, 400),
  };
}

async function runGit(
  args: string[],
  cwd: string,
): Promise<{ exit: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exit] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exit: typeof exit === "number" ? exit : -1, stdout, stderr };
}

function lines(value: string): string[] {
  return value.split("\n").filter((line) => line.length > 0);
}
