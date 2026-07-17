import { createDuplexChannel } from "@/kernel/std/stream/duplex.ts";

export interface QuestionOption {
  label: string;
  description: string;
  preview?: string;
}

export interface GroupQuestion {
  question: string;
  header?: string;
  options: QuestionOption[];
  multiSelect: boolean;
  allowFreeform?: boolean;
  allowChat?: boolean;
}

export interface GroupAnswer {
  question: string;
  answer: string;
}

export type GroupResult =
  | { declined: true; reason: "cancel" | "chat" }
  | { declined: false; answers: GroupAnswer[] };

export interface PendingGroup {
  id: string;
  questions: GroupQuestion[];
  resolve: (result: GroupResult) => void;
}

const channel = createDuplexChannel<PendingGroup, GroupResult>("askg");

export function askGroup(questions: GroupQuestion[]): Promise<GroupResult> {
  return channel.ask((id, resolve) => ({ id, questions, resolve }));
}

export async function askGroupWithDefault(
  questions: GroupQuestion[],
  timeoutMs: number,
  defaultResult: GroupResult,
): Promise<{ result: GroupResult; timedOut: boolean }> {
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const result = await channel.ask((id, resolve) => {
    timer = setTimeout(
      () => {
        timedOut = true;
        channel.answer(id, defaultResult);
      },
      Math.max(0, timeoutMs),
    );
    return { id, questions, resolve };
  });
  if (timer !== undefined) clearTimeout(timer);
  return { result, timedOut };
}

export function resolveGroup(id: string, result: GroupResult): boolean {
  return channel.answer(id, result);
}

export function peek(): PendingGroup | null {
  return channel.peek();
}

export function pending(): PendingGroup[] {
  return channel.list();
}

export function subscribe(fn: (queue: PendingGroup[]) => void): () => void {
  return channel.subscribe(fn);
}

export function clear(): void {
  channel.clear(() => ({ declined: true, reason: "cancel" }));
}
