import { useState } from "react";
import type { ErrorActionId, ErrorMeta } from "@/engine/transport/error-meta.ts";
import { Box, Text } from "@/ink";
import { FooterPanel } from "@/ui/chrome/panel.tsx";
import { usePanelNavigation } from "@/ui/hooks/use-panel-navigation.ts";
import { Color, Glyph } from "@/ui/theme/theme.ts";

export interface ErrorPanelProps {
  meta: ErrorMeta;
  attemptCount: number;
  rawExpanded: boolean;
  onAction: (id: ErrorActionId) => void;
  onToggleRaw: () => void;
  onDismiss: () => void;
}

const RAW_DETAIL_CAP = 4000;

function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

export function ErrorPanel({
  meta,
  attemptCount,
  rawExpanded,
  onAction,
  onToggleRaw,
  onDismiss,
}: ErrorPanelProps): React.JSX.Element {
  const [selected, setSelected] = useState(0);
  const count = meta.actions.length;

  usePanelNavigation({
    onClose: onDismiss,
    onActivate: () => {
      const action = meta.actions[selected];
      if (action) onAction(action.id);
    },
    onKey: (input, key) => {
      if (key.upArrow || (key.shift && key.tab)) {
        if (count > 0) setSelected((idx) => (idx + count - 1) % count);
        return true;
      }
      if (key.downArrow || key.tab) {
        if (count > 0) setSelected((idx) => (idx + 1) % count);
        return true;
      }
      if (input === "d" || input === "D") {
        onToggleRaw();
        return true;
      }
      const digit = Number.parseInt(input, 10);
      if (Number.isInteger(digit) && digit >= 1 && digit <= count) {
        const idx = digit - 1;
        setSelected(idx);
        const action = meta.actions[idx];
        if (action) onAction(action.id);
        return true;
      }
      return false;
    },
  });

  const title = attemptCount > 1 ? `${meta.title} · ${ordinal(attemptCount)} attempt` : meta.title;
  const rawDetail =
    meta.rawDetail.length > RAW_DETAIL_CAP
      ? meta.rawDetail.slice(0, RAW_DETAIL_CAP)
      : meta.rawDetail;

  return (
    <FooterPanel
      title={title}
      onCancel={onDismiss}
      footerHints={[
        ["Enter", "confirm"],
        ["d", "details"],
        ["Esc", "cancel"],
      ]}
    >
      <Box flexDirection="column" marginTop={1}>
        <Box marginBottom={1}>
          <Text color={Color.text}>{meta.summary}</Text>
        </Box>
        {meta.actions.map((action, idx) => {
          const isSelected = idx === selected;
          return (
            <Box key={action.id} flexDirection="row">
              <Text color={isSelected ? Color.highlight : Color.muted}>
                {isSelected ? Glyph.chevron : "  "}
              </Text>
              <Text color={isSelected ? Color.highlight : Color.text}>
                {`${idx + 1}. ${action.label}`}
              </Text>
            </Box>
          );
        })}
        <Box marginTop={1} flexDirection="column">
          <Text color={Color.muted}>
            {rawExpanded
              ? `${Glyph.triangleFilled} Hide details (d)`
              : `${Glyph.triangle} Show details (d)`}
          </Text>
          {rawExpanded && <Text color={Color.muted}>{rawDetail}</Text>}
        </Box>
      </Box>
    </FooterPanel>
  );
}
