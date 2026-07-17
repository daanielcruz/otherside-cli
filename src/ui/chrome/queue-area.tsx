import type * as React from "react";
import { memo } from "react";
import type { QueuedMessage } from "@/store/queue-store/index.ts";
import { QueuePreview } from "@/ui/chrome/queue-preview.tsx";

export interface QueueAreaProps {
  messages: readonly QueuedMessage[];
  active: boolean;
}

// Queued-input preview under the promptbar. This surface shows ONLY messages
// the user queued for the next boundary (typed mid-turn, pending slash-command
// changes). Background-task completion notifications never render here: they
// are delivered to the model at a queue boundary and surface in the transcript
// as task notices at that moment — a queued completion (own scope or a
// subagent owner's) has no promptbar row.
const QueueAreaInner = (props: QueueAreaProps): React.JSX.Element => {
  const visible = props.active ? props.messages : [];
  return <QueuePreview messages={visible} active={visible.length > 0} />;
};

export const QueueArea = memo(QueueAreaInner);
