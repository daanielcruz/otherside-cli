import { useState } from "react";
import { Box, Text, useIsScreenReaderEnabled } from "@/ink";
import { FooterPanel } from "@/ui/chrome/panel.tsx";
import { usePanelNavigation } from "@/ui/hooks/use-panel-navigation.ts";
import { Color, Glyph } from "@/ui/theme/theme.ts";

export interface ConfirmOverlayProps {
  question: string;
  yesLabel?: string;
  noLabel?: string;
  defaultChoice?: "yes" | "no";
  onConfirm: () => void;
  onCancel: () => void;
  inputGuide?: string;
}

const FOOTER_HINTS: [string, string][] = [
  ["↑/↓", "select"],
  ["Enter", "confirm"],
  ["Esc", "cancel"],
];

export function ConfirmOverlay({
  question,
  yesLabel = "Yes",
  noLabel = "No",
  defaultChoice = "no",
  onConfirm,
  onCancel,
  inputGuide,
}: ConfirmOverlayProps): React.JSX.Element {
  const [choice, setChoice] = useState<"yes" | "no">(defaultChoice);
  const screenReader = useIsScreenReaderEnabled();

  usePanelNavigation({
    onClose: onCancel,
    onActivate: onConfirm,
    rows: {
      count: 2,
      selected: choice === "yes" ? 0 : 1,
      onChange: (idx) => setChoice(idx === 0 ? "yes" : "no"),
    },
    onKey: (input) => {
      if (input === "k") {
        setChoice("yes");
        return true;
      }
      if (input === "j") {
        setChoice("no");
        return true;
      }
      return false;
    },
  });

  return (
    <FooterPanel
      title={question}
      footerHints={FOOTER_HINTS}
      onCancel={onCancel}
      {...(inputGuide !== undefined ? { inputGuide } : {})}
    >
      {screenReader && (
        <Box flexDirection="column">
          <Text>{choice === "yes" ? `[selected] ${yesLabel}` : yesLabel}</Text>
          <Text>{choice === "no" ? `[selected] ${noLabel}` : noLabel}</Text>
        </Box>
      )}
      {!screenReader && (
        <Box flexDirection="column">
          <ConfirmOption label={yesLabel} selected={choice === "yes"} />
          <ConfirmOption label={noLabel} selected={choice === "no"} />
        </Box>
      )}
    </FooterPanel>
  );
}

function ConfirmOption({
  label,
  selected,
}: {
  label: string;
  selected: boolean;
}): React.JSX.Element {
  return (
    <Box>
      <Text color={selected ? Color.highlight : Color.muted}>
        {selected ? Glyph.chevron : "  "}
      </Text>
      <Text bold={selected} color={selected ? Color.highlight : Color.text}>
        {label}
      </Text>
    </Box>
  );
}
