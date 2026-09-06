import { subscribe as subscribeBackgroundTasks } from "@/engine/background/tasks/background.ts";
import { appStore } from "@/store/app-store/index.ts";
import {
  getTranscriptEntries,
  transcriptActions,
  transcriptStore,
} from "@/store/transcript/index.ts";
import { transcriptLiveStore } from "@/store/transcript/live.ts";
import type {
  ScrollbackBatch,
  StringComponent,
  StringViewContext,
} from "@/terminal-runtime/string-view/component.js";
import { renderSettledEntries } from "@/ui/transcript/entry-lines.ts";
import {
  selectDetailedTranscriptEntries,
  type TranscriptPresentation,
  transcriptPresentationFor,
} from "@/ui/transcript/presentation.ts";
import { SettledScrollbackArchive } from "@/ui/transcript/scrollback-archive.ts";
import { settledEntriesOf } from "@/ui/transcript/settled-boundary.ts";
import type { SettledEntry } from "@/ui/transcript/settled-entry.ts";
import {
  freezeAgentTaskProjection,
  mapTranscriptEntries,
} from "@/ui/transcript/string-view-store.ts";
import { TOOL_PULSE_INTERVAL_MS } from "@/ui/transcript/string-view-tool.ts";

export { entryLines, renderSettledEntries } from "@/ui/transcript/entry-lines.ts";
export type { SettledEntry } from "@/ui/transcript/settled-entry.ts";

export class StringViewTranscript implements StringComponent {
  private entries: readonly SettledEntry[] = [];
  /**
   * The prefix of `entries` that has stopped changing, resolved when the entries are
   * set rather than per paint: a render must never walk the settled history it is not
   * going to draw.
   */
  private settledEntries: readonly SettledEntry[] = [];
  private readonly archive = new SettledScrollbackArchive();
  private readonly unsubs: (() => void)[] = [];
  private presentation: TranscriptPresentation;
  private pulseTimer: ReturnType<typeof setInterval> | undefined;
  private requestRender: (() => void) | undefined;

  constructor() {
    this.presentation = this.readPresentation();
  }

  mount(ctx: StringViewContext): void {
    this.unmount();
    const refresh = (): void => {
      // The freeze runs before the mapping so a finished task's final data
      // lands on its entry in the same step that re-derives the settled set.
      // A backgrounded row settles at launch, so this restamp legitimately
      // changes settled history — the non-destructive reflow path repaints
      // the archive once per completion.
      transcriptActions.update(freezeAgentTaskProjection);
      this.setEntries(mapTranscriptEntries(getTranscriptEntries()));
      ctx.requestRender();
    };
    this.requestRender = ctx.requestRender;
    this.unsubs.push(
      transcriptStore.subscribe(refresh),
      subscribeBackgroundTasks(refresh),
      appStore.subscribe(() => {
        const next = this.readPresentation();
        if (next === this.presentation) return;
        this.presentation = next;
        this.archive.invalidate();
        ctx.requestRender();
      }),
      transcriptLiveStore.subscribe(() => ctx.requestRender()),
    );
    this.presentation = this.readPresentation();
    this.setEntries(mapTranscriptEntries(getTranscriptEntries()));
    ctx.requestRender();
  }

  unmount(): void {
    this.clearPulseTimer();
    this.requestRender = undefined;
    for (const unsub of this.unsubs.splice(0)) unsub();
  }

  setEntries(entries: readonly SettledEntry[]): void {
    // Only the settled prefix decides this: a tool still in flight is not part of the
    // document, so its ticking must not make the document look non-appending.
    const settled = settledEntriesOf(entries);
    this.archive.setSettled(settled);
    this.entries = entries;
    this.settledEntries = settled;
    this.syncPulseTimer();
  }

  /**
   * A tool still in flight pulses its bullet, and a silent one produces no store event
   * to redraw on, so the beat needs a clock. It runs only while such a tool exists,
   * because each beat re-lays-out the document to pick up the new elapsed time.
   */
  private syncPulseTimer(): void {
    const wanted = this.entries.some(
      (entry) =>
        entry.kind === "tool" &&
        entry.data.status === "running" &&
        entry.data.isBackgrounded !== true,
    );
    if (wanted === (this.pulseTimer !== undefined)) return;
    if (!wanted) {
      this.clearPulseTimer();
      return;
    }
    const tick = this.requestRender;
    if (tick === undefined) return;
    this.pulseTimer = setInterval(() => {
      this.setEntries(mapTranscriptEntries(getTranscriptEntries()));
      tick();
    }, TOOL_PULSE_INTERVAL_MS);
    this.pulseTimer.unref?.();
  }

  private clearPulseTimer(): void {
    if (this.pulseTimer !== undefined) clearInterval(this.pulseTimer);
    this.pulseTimer = undefined;
  }

  append(entry: SettledEntry): void {
    this.setEntries([...this.entries, entry]);
  }

  getPresentation(): TranscriptPresentation {
    return this.presentation;
  }

  takeScrollbackBatch(width: number): ScrollbackBatch {
    return this.archive.takeBatch(width, this.presentation);
  }

  snapshotScrollback(width: number): readonly string[] {
    return this.archive.snapshot(width, this.presentation);
  }

  /**
   * The live frame carries what has not settled — a tool still in flight and anything
   * after it — ahead of the streaming text. Those rows join the document once they stop
   * changing, so a running tool costs its own rows, not the history above it.
   */
  renderLive(width: number): string[] {
    const inFlight = this.entries.slice(this.settledEntries.length);
    return this.renderEntries(width, [...inFlight, ...this.liveEntries()], this.presentation);
  }

  render(width: number): string[] {
    const live = this.liveEntries();
    const entries = live.length > 0 ? [...this.entries, ...live] : this.entries;
    return this.renderEntries(width, entries, this.presentation);
  }

  private liveEntries(): SettledEntry[] {
    const { streamingId, streamingText, streamingThinking, committedLen } =
      transcriptLiveStore.getState();
    if (streamingId === null) return [];
    const entries: SettledEntry[] = [];
    if (streamingThinking.trim().length > 0) {
      entries.push({ kind: "thinking", text: streamingThinking });
    }
    if (streamingText.length > 0) {
      const committed = Math.min(Math.max(0, committedLen), streamingText.length);
      const tail = committed > 0 ? streamingText.slice(committed) : streamingText;
      if (tail.length > 0) {
        entries.push({
          kind: "assistant",
          text: tail,
          ...(committed > 0 ? { continuation: true } : {}),
        });
      }
    }
    return entries;
  }

  renderDetailed(width: number, showAll: boolean): string[] {
    const entries = selectDetailedTranscriptEntries(this.entries, showAll);
    return this.renderEntries(width, entries, "detailed");
  }

  private renderEntries(
    width: number,
    entries: readonly SettledEntry[],
    presentation: TranscriptPresentation,
  ): string[] {
    return renderSettledEntries(width, entries, presentation);
  }

  private readPresentation(): TranscriptPresentation {
    const view = appStore.getState().view;
    return transcriptPresentationFor(view.transcriptScreen, view.verboseTranscript);
  }
}
