import { type BroadcastEntry, createBroadcastChannel } from "@/kernel/std/stream/broadcast.ts";

export type NotificationKind = "info" | "success" | "error";

export type Notification = BroadcastEntry<string, NotificationKind> & {
  text: string;
};

type Listener = (queue: Notification[]) => void;

const channel = createBroadcastChannel<string, NotificationKind>({ prefix: "notif" });

function toNotification(entry: BroadcastEntry<string, NotificationKind>): Notification {
  return { ...entry, text: entry.payload };
}

export function publish(kind: NotificationKind, text: string): Notification {
  return toNotification(channel.publish(kind, text));
}

export function snapshot(): Notification[] {
  return channel.snapshot().map(toNotification);
}

export function subscribe(fn: Listener): () => void {
  return channel.subscribe((history) => fn(history.map(toNotification)));
}

export function clear(): void {
  channel.clear();
}
