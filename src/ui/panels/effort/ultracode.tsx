import { useState } from "react";
import { effortLevelsForModel } from "@/engine/model/catalog.ts";
import { Box, Text } from "@/ink";
import { type UserConfig, updateConfig } from "@/kernel/config/config.ts";
import { EFFORT_LEVEL_VALUES, type EffortLevel } from "@/kernel/std/types/effort.ts";
import type { Broker } from "@/store/app-store/broker.ts";
import { FooterPanel } from "@/ui/chrome/panel.tsx";
import { usePanelNavigation } from "@/ui/hooks/use-panel-navigation.ts";
import { useOverlayDispatch } from "@/ui/panels/context";
import { useOverlayClose } from "@/ui/panels/use-overlay-close";
import { Color, Glyph } from "@/ui/theme/theme.ts";

const ULTRACODE_EFFORT_CHOICES = EFFORT_LEVEL_VALUES;
type UltracodeEffortChoice = EffortLevel;
const ULTRACODE_EFFORT_CHOICE_SET: ReadonlySet<string> = new Set(ULTRACODE_EFFORT_CHOICES);

export interface UltracodeEffortOverlayProps {
  broker: Broker;
  config: UserConfig;
  onConfigChange?: ((config: UserConfig) => void) | undefined;
  onClose?: () => void;
}

export function UltracodeEffortOverlay({
  broker,
  config,
  onConfigChange,
  onClose,
}: UltracodeEffortOverlayProps): React.JSX.Element {
  const close = useOverlayClose(onClose);
  const dispatch = useOverlayDispatch();
  const state = broker.read();
  const levels = effortLevelsForModel(state.model, state.provider).filter(isUltracodeChoice);
  const desired = config.ultracodeEffort ?? "high";
  const [idx, setIdx] = useState(() => {
    const desiredIdx = levels.indexOf(desired);
    if (desiredIdx >= 0) return desiredIdx;
    const highIdx = levels.indexOf("high");
    return highIdx >= 0 ? highIdx : Math.max(0, levels.length - 1);
  });

  const commit = (): void => {
    const chosen = levels[idx];
    if (!chosen) return;
    const next: UserConfig = { ...config, ultracodeEffort: chosen, ultracode: true };
    onConfigChange?.(next);
    void updateConfig((current) => {
      current.ultracodeEffort = chosen;
      current.ultracode = true;
    });
    broker.dispatch({ kind: "set_ultracode", enabled: true, effort: chosen });
    dispatch.recordPanelCommit?.("effort", `ultracode with ${chosen} effort`);
    close();
  };

  usePanelNavigation({
    onClose: close,
    onActivate: commit,
    rows: { count: levels.length, selected: idx, onChange: setIdx },
    onKey: (_input, key) => {
      if (key.leftArrow) {
        setIdx((current) => Math.max(0, current - 1));
        return true;
      }
      if (key.rightArrow) {
        setIdx((current) => Math.min(levels.length - 1, current + 1));
        return true;
      }
      return false;
    },
  });

  return (
    <FooterPanel
      command="/effort ultracode"
      title="Ultracode effort"
      onCancel={close}
      footerHints={[
        ["↑/↓", "select"],
        ["Enter", "confirm"],
        ["Esc", "cancel"],
      ]}
    >
      <Text color={Color.muted}>Which ultracode effort do you want? (saved to config)</Text>
      <Box flexDirection="column" marginTop={1}>
        {levels.map((level, position) => (
          <Box key={level}>
            <Text color={position === idx ? Color.primaryGlow : Color.muted}>
              {position === idx ? Glyph.chevron : "  "}
            </Text>
            <Text color={Color.text} bold={position === idx}>
              {level}
            </Text>
          </Box>
        ))}
      </Box>
    </FooterPanel>
  );
}

export function isUltracodeChoice(level: EffortLevel): level is UltracodeEffortChoice {
  return ULTRACODE_EFFORT_CHOICE_SET.has(level);
}
