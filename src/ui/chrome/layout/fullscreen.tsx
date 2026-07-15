import { type ReactNode, useEffect, useRef, useState } from "react";
import { Box, Text, useTerminalDimensions } from "@/ink";
import { ModalReducedContext } from "@/ui/chrome/modal-reduced-context.ts";
import { Color } from "@/ui/theme/theme.ts";

export interface FullscreenLayoutProps {
  scrollable: ReactNode;
  bottom: ReactNode;
  overlay?: ReactNode;
  modal?: ReactNode;
  itemCount?: number;
}

function NewMessagePill({
  itemCount,
  hasOverlay,
}: {
  itemCount: number;
  hasOverlay: boolean;
}): React.JSX.Element {
  const lastCountRef = useRef(itemCount);
  const [newCount, setNewCount] = useState(0);

  useEffect(() => {
    if (hasOverlay) {
      lastCountRef.current = itemCount;
      setNewCount(0);
      return;
    }
    const diff = itemCount - lastCountRef.current;
    if (diff > 0) {
      lastCountRef.current = itemCount;
      setNewCount((prev) => prev + diff);
      const t = setTimeout(() => setNewCount(0), 3000);
      return () => clearTimeout(t);
    }
  }, [itemCount, hasOverlay]);

  return (
    <>
      {newCount > 0 && !hasOverlay && (
        <Box position="absolute" bottom={2} right={2}>
          <Box backgroundColor={Color.primaryGlow} paddingX={1}>
            <Text color="ansi:black" bold>{`↓ ${newCount} new`}</Text>
          </Box>
        </Box>
      )}
    </>
  );
}

export function FullscreenLayout({
  scrollable,
  bottom,
  overlay,
  modal,
  itemCount = 0,
}: FullscreenLayoutProps): React.JSX.Element {
  const { rows, columns } = useTerminalDimensions();

  return (
    <Box flexDirection="column" width="100%" height={Math.max(1, rows)} flexShrink={0}>
      <Box flexGrow={1} flexDirection="column" overflow="hidden">
        <Box flexGrow={1} flexShrink={1}>
          {scrollable}
          {overlay}
        </Box>
      </Box>
      <Box flexDirection="column" flexShrink={0} width="100%" maxHeight="50%">
        {bottom}
      </Box>
      <NewMessagePill itemCount={itemCount} hasOverlay={!!modal || !!overlay} />
      {modal != null && (
        <Box
          position="absolute"
          bottom={0}
          left={0}
          right={0}
          maxHeight={Math.max(1, rows - 2)}
          flexDirection="column"
          overflow="hidden"
        >
          <Box flexShrink={0}>
            <Text color={Color.warning}>{"▔".repeat(Math.max(1, columns))}</Text>
          </Box>
          <Box flexDirection="column" paddingX={2} flexShrink={0} overflow="hidden">
            <ModalReducedContext.Provider value={true}>{modal}</ModalReducedContext.Provider>
          </Box>
        </Box>
      )}
    </Box>
  );
}
