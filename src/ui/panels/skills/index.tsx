import { useState } from "react";
import { list } from "@/engine/skills/registry.ts";
import { Box, Text } from "@/ink";
import { FooterPanel, FooterPanelRow } from "@/ui/chrome/panel.tsx";
import { usePanelNavigation } from "@/ui/hooks/use-panel-navigation.ts";
import { useOverlayClose } from "@/ui/panels/use-overlay-close";
import { Color } from "@/ui/theme/theme.ts";

export interface SkillsOverlayProps {
  onClose?: () => void;
}

export function SkillsOverlay({ onClose }: SkillsOverlayProps = {}): React.JSX.Element {
  const close = useOverlayClose(onClose);
  const skills = list();
  const [idx, setIdx] = useState(0);

  usePanelNavigation({
    onClose: close,
    rows: { count: skills.length, selected: idx, onChange: setIdx },
  });

  return (
    <FooterPanel
      command="/skills"
      title="Skills"
      onCancel={close}
      footerHints={[
        ["↑↓", "navigate"],
        ["Esc", "close"],
      ]}
    >
      {skills.length === 0 ? (
        <Text color={Color.muted}>no skills registered</Text>
      ) : (
        skills.map((s, i) => (
          <Box key={s.name} flexDirection="column">
            <FooterPanelRow
              label={s.name}
              value={s.builtin ? "builtin" : undefined}
              selected={i === idx}
              active={s.builtin}
              width={32}
            />
            <Box paddingLeft={2}>
              <Text color={Color.muted}>{s.description}</Text>
            </Box>
          </Box>
        ))
      )}
    </FooterPanel>
  );
}
