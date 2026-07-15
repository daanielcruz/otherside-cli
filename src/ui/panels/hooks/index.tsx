import { useMemo, useState } from "react";
import { Box, Text } from "@/ink";
import { configPath, type UserConfig } from "@/kernel/config/config.ts";
import type { HookEntry, HookEvent } from "@/kernel/hooks/index.ts";
import { listAllSessionHooks } from "@/kernel/hooks/session-registry.ts";
import { FooterPanel, FooterPanelRow } from "@/ui/chrome/panel.tsx";
import { usePanelNavigation } from "@/ui/hooks/use-panel-navigation.ts";
import { useOverlayState } from "@/ui/panels/context";
import { useOverlayClose } from "@/ui/panels/use-overlay-close";
import { Color } from "@/ui/theme/theme.ts";

export interface HooksOverlayProps {
  config?: UserConfig;
  sessionId?: string;
  onClose?: () => void;
}

const HOOK_EVENTS: HookEvent[] = [
  "preToolUse",
  "postToolUse",
  "userPromptSubmit",
  "stop",
  "subagentStop",
  "preCompact",
];

interface HookRow {
  event: HookEvent;
  entry: HookEntry | null;
  index: number;
  via?: string;
}

export function HooksOverlay({
  config,
  sessionId,
  onClose,
}: HooksOverlayProps = {}): React.JSX.Element {
  const state = useOverlayState();
  const activeConfig = config ?? state.config;
  const sid = sessionId ?? state.session.id;
  const close = useOverlayClose(onClose);
  const [idx, setIdx] = useState(0);
  const hooks = useMemo(() => cloneHooks(activeConfig.hooks), [activeConfig.hooks]);
  const sessionHooks = useMemo(() => listAllSessionHooks(sid), [sid]);
  const rows = useMemo(() => hookRows(hooks, sessionHooks), [hooks, sessionHooks]);
  const configuredCount = rows.filter((row) => row.entry !== null).length;

  usePanelNavigation({
    onClose: close,
    rows: { count: rows.length, selected: idx, onChange: setIdx },
    onKey: (input) => {
      if (input === "q") {
        close();
        return true;
      }
      return false;
    },
  });

  return (
    <FooterPanel
      command="/hooks"
      title="Hooks"
      onCancel={close}
      footerHints={[
        ["↑↓", "navigate"],
        ["Esc", "close"],
      ]}
    >
      <Text color={Color.text}>{configuredCount} hooks configured</Text>
      <Box marginTop={1}>
        <Text color={Color.muted}>read-only · edit {configPath()} to modify hooks</Text>
      </Box>
      <FooterPanelRow label="Settings file" value={configPath()} muted width={22} />
      <Box flexDirection="column" marginTop={1}>
        {rows.map((row, i) =>
          row.entry ? (
            <Box key={`${row.event}:${row.index}:${row.via ?? "cfg"}`} flexDirection="column">
              <FooterPanelRow
                label={row.via ? `${row.event} (via: ${row.via})` : row.event}
                value={row.entry.matcher.length > 0 ? row.entry.matcher : "<any>"}
                selected={i === idx}
                active
                width={24}
              />
              <Box paddingLeft={2}>
                <Text color={Color.muted}>
                  {clip(
                    row.entry.type === "prompt" ? `prompt: ${row.entry.prompt}` : row.entry.command,
                    100,
                  )}
                </Text>
              </Box>
            </Box>
          ) : (
            <FooterPanelRow
              key={row.event}
              label={row.event}
              value="no hooks configured"
              selected={i === idx}
              muted
              width={24}
            />
          ),
        )}
      </Box>
    </FooterPanel>
  );
}

function hookRows(
  hooks: Partial<Record<HookEvent, HookEntry[]>>,
  sessionHooks: Map<HookEvent, { entry: HookEntry; via: string }[]>,
): HookRow[] {
  const rows: HookRow[] = [];
  for (const event of HOOK_EVENTS) {
    const cfgEntries = hooks[event] ?? [];
    const sessEntries = sessionHooks.get(event) ?? [];
    if (cfgEntries.length === 0 && sessEntries.length === 0) {
      rows.push({ event, entry: null, index: -1 });
      continue;
    }
    for (const [index, entry] of cfgEntries.entries()) {
      rows.push({ event, entry, index });
    }
    for (const [index, sess] of sessEntries.entries()) {
      rows.push({ event, entry: sess.entry, index: cfgEntries.length + index, via: sess.via });
    }
  }
  return rows;
}

function cloneHooks(
  hooks: Partial<Record<HookEvent, HookEntry[]>> | undefined,
): Partial<Record<HookEvent, HookEntry[]>> {
  const out: Partial<Record<HookEvent, HookEntry[]>> = {};
  for (const event of HOOK_EVENTS) {
    const entries = hooks?.[event];
    if (entries && entries.length > 0) out[event] = entries.map((entry) => ({ ...entry }));
  }
  return out;
}

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
