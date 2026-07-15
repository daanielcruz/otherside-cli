import type * as React from "react";
import { memo } from "react";
import type { QueuedMessage } from "@/store/queue-store/index.ts";
import { QueuePreview } from "@/ui/chrome/queue-preview.tsx";

export interface QueueAreaProps {
  messages: readonly QueuedMessage[];
  active: boolean;
}

const QueueAreaInner = (props: QueueAreaProps): React.JSX.Element => (
  <QueuePreview messages={props.messages} active={props.active} />
);

export const QueueArea = memo(QueueAreaInner);
