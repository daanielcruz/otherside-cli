import { useState } from "react";
import { killBackground, listBackground } from "@/engine/tools/builtins/bash.ts";
import { Box, Text } from "@/ink";
import { ListPanel, type ListPanelItem } from "@/ui/chrome/panel.tsx";
import { useDisposableInterval } from "@/ui/panels/use-disposable-interval";
import { useOverlayClose } from "@/ui/panels/use-overlay-close";
import { Color, Glyph } from "@/ui/theme/theme.ts";

export interface BashesOverlayProps {
  onClose?: () => void;
}

export function BashesOverlay({ onClose }: BashesOverlayProps = {}): React.JSX.Element {
  const close = useOverlayClose(onClose);
  const [cursor, setCursor] = useState(0);
  const [tick, setTick] = useState(0);
  const bashes = listBackground().filter((b) => b.status === "running");

  useDisposableInterval(() => {
    setTick((n) => n + 1);
  }, 500);
  void tick;

  const listItems: ListPanelItem[] = bashes.map((b) => {
    const elapsed = Math.floor((Date.now() - b.startedAt) / 1000);
    const statusColor = b.status === "running" ? Color.success : Color.muted;
    const label = (
      <Box>
        <Text color={statusColor}>
          {b.status === "running" ? `${Glyph.bulletFilled} ` : `${Glyph.bulletHollow} `}
        </Text>
        <Text color={Color.primaryGlow}>{b.id}</Text>
        <Text color={Color.muted}> · {elapsed}s · </Text>
        <Text>{b.command.slice(0, 60)}</Text>
        {b.exitCode !== null && (
          <Text color={b.exitCode === 0 ? Color.success : Color.error}> exit {b.exitCode}</Text>
        )}
      </Box>
    );

    return {
      id: b.id,
      label,
    };
  });

  return (
    <ListPanel
      command="/bashes"
      title="Bashes"
      items={listItems}
      selectedIndex={cursor}
      onSelectedIndexChange={setCursor}
      onCancel={close}
      onKey={(input, _key) => {
        if (input === "q") {
          close();
          return true;
        }
        if (input === "x") {
          const selected = bashes[cursor];
          if (selected) killBackground(selected.id);
          return true;
        }
        return false;
      }}
      footerHints={[
        ["↑↓", "navigate"],
        ["x", "stop"],
        ["Esc", "close"],
      ]}
    />
  );
}
