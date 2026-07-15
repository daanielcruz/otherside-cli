import { useEffect, useState } from "react";
import { Box, Text } from "@/ink";
import { type UserConfig, updateConfig } from "@/kernel/config/config.ts";
import { ListPanel, type ListPanelItem } from "@/ui/chrome/panel.tsx";
import { useOverlayDispatch, useOverlayState } from "@/ui/panels/context";
import { useOverlayClose } from "@/ui/panels/use-overlay-close";
import { resolveThemeSetting } from "@/ui/theme/system-theme.ts";
import { Color, setActiveTheme, THEME_SETTINGS, type ThemeSetting } from "@/ui/theme/theme.ts";

const ROWS: { setting: ThemeSetting; label: string; description: string }[] = [
  { setting: "auto", label: "Auto", description: "Match terminal background" },
  { setting: "dark", label: "Dark", description: "Default dark palette" },
  { setting: "light", label: "Light", description: "Default light palette" },
  {
    setting: "dark-daltonized",
    label: "Dark — Daltonized",
    description: "Dark with deuteranopia-friendly diff colors",
  },
  {
    setting: "light-daltonized",
    label: "Light — Daltonized",
    description: "Light with deuteranopia-friendly diff colors",
  },
  {
    setting: "dark-ansi",
    label: "Dark — ANSI",
    description: "Dark for terminals without truecolor",
  },
  {
    setting: "light-ansi",
    label: "Light — ANSI",
    description: "Light for terminals without truecolor",
  },
];

export interface ThemeOverlayProps {
  config?: UserConfig;
  onClose?: () => void;
  onConfigChange?: ((config: UserConfig) => void) | undefined;
}

export function ThemeOverlay({
  config,
  onClose,
  onConfigChange,
}: ThemeOverlayProps = {}): React.JSX.Element {
  const state = useOverlayState();
  const dispatch = useOverlayDispatch();
  const activeConfig = config ?? state.config;
  const close = useOverlayClose(onClose);
  const applyConfig = onConfigChange ?? dispatch.onConfigChange;
  const initialSetting: ThemeSetting = activeConfig.theme ?? "auto";
  const [previewSetting, setPreviewSetting] = useState<ThemeSetting>(initialSetting);
  const [bodyIdx, setBodyIdx] = useState(() =>
    Math.max(
      0,
      ROWS.findIndex((r) => r.setting === initialSetting),
    ),
  );

  useEffect(() => {
    return () => {
      if (previewSetting !== initialSetting) {
        setActiveTheme(resolveThemeSetting(initialSetting));
      }
    };
  }, [previewSetting, initialSetting]);

  useEffect(() => {
    setActiveTheme(resolveThemeSetting(previewSetting));
  }, [previewSetting]);

  const firstLaunch = activeConfig.theme === undefined;
  const listItems: ListPanelItem[] = ROWS.map((r) => ({
    id: r.setting,
    label: r.label,
    value: r.description,
    active: !firstLaunch && r.setting === initialSetting,
  }));

  return (
    <ListPanel
      {...(firstLaunch ? {} : { command: "/theme" })}
      title={firstLaunch ? "Choose your theme" : "Theme picker"}
      items={listItems}
      selectedIndex={bodyIdx}
      onSelectedIndexChange={(next) => {
        setBodyIdx(next);
        setPreviewSetting(ROWS[next]?.setting ?? "auto");
      }}
      onSelect={(item) => {
        const chosen = item.id as ThemeSetting;
        const nextCfg = { ...activeConfig, theme: chosen };
        applyConfig?.(nextCfg);
        void updateConfig((cfg) => {
          cfg.theme = chosen;
        });
        setActiveTheme(resolveThemeSetting(chosen));
        close();
      }}
      onCancel={() => {
        setActiveTheme(resolveThemeSetting(initialSetting));
        close();
      }}
      footerHints={[
        ["↑↓", "preview"],
        ["Enter", "save"],
        ["Esc", "cancel"],
      ]}
    >
      {firstLaunch && (
        <Box marginBottom={1}>
          <Text color={Color.muted}>
            Pick a palette for the TUI. You can change it later with /theme.
          </Text>
        </Box>
      )}
      <Box marginTop={1} marginBottom={1}>
        <Text color={Color.muted}>Live preview as you navigate.</Text>
      </Box>
    </ListPanel>
  );
}

export const THEME_OVERLAY_KNOWN: ReadonlyArray<ThemeSetting> = THEME_SETTINGS;
