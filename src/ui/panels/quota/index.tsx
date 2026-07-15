import { useState } from "react";
import { Box, Text } from "@/ink";
import { FooterPanel } from "@/ui/chrome/panel.tsx";
import { usePanelNavigation } from "@/ui/hooks/use-panel-navigation.ts";
import { useOptionalOverlayDispatch } from "@/ui/panels/context";
import { Color, Glyph } from "@/ui/theme/theme.ts";

export interface QuotaOverlayProps {
  onSwitchModel?: () => void;
  onDismiss?: () => void;
}

const OPTIONS = [
  { key: "switch", label: "Switch model" },
  { key: "stop", label: "Stop and wait for limit to reset" },
] as const;

export function QuotaOverlay({
  onSwitchModel,
  onDismiss,
}: QuotaOverlayProps = {}): React.JSX.Element {
  const dispatch = useOptionalOverlayDispatch();
  const dismiss = onDismiss ?? dispatch?.closeOverlay ?? (() => {});
  const switchModel = onSwitchModel ?? dispatch?.closeOverlay ?? (() => {});
  const [selected, setSelected] = useState(0);

  usePanelNavigation({
    onClose: dismiss,
    onActivate: () => {
      const choice = OPTIONS[selected]?.key;
      if (choice === "switch") switchModel();
      else if (choice === "stop") dismiss();
    },
    onKey: (input, key) => {
      if (key.upArrow || (key.shift && key.tab)) {
        setSelected((idx) => (idx + OPTIONS.length - 1) % OPTIONS.length);
        return true;
      }
      if (key.downArrow || key.tab) {
        setSelected((idx) => (idx + 1) % OPTIONS.length);
        return true;
      }
      if (key.ctrl && (input === "c" || input === "C")) {
        dismiss();
        return true;
      }
      if (input === "1") {
        setSelected(0);
        switchModel();
        return true;
      }
      if (input === "2") {
        setSelected(1);
        dismiss();
        return true;
      }
      return false;
    },
  });

  return (
    <FooterPanel
      title="What do you want to do?"
      onCancel={dismiss}
      footerHints={[
        ["Enter", "confirm"],
        ["Esc", "cancel"],
      ]}
    >
      <Box flexDirection="column" marginTop={1}>
        {OPTIONS.map((opt, idx) => {
          const isSelected = idx === selected;
          return (
            <Box key={opt.key} flexDirection="row">
              <Text color={isSelected ? Color.highlight : Color.muted}>
                {isSelected ? Glyph.chevron : "  "}
              </Text>
              <Text color={isSelected ? Color.highlight : Color.text}>
                {`${idx + 1}. ${opt.label}`}
              </Text>
            </Box>
          );
        })}
      </Box>
    </FooterPanel>
  );
}
