import { afterEach, describe, expect, test } from "bun:test";
import { appStore, dispatch } from "@/store/app-store/index.ts";
import { startTerminalProgressSubscriber } from "@/store/subscribers/terminal-progress.ts";
import type { TerminalProgressState } from "@/terminal-runtime";

function setBusy(busy: boolean): void {
  dispatch({ type: "view/setBusy", busy });
}

afterEach(() => {
  setBusy(false);
});

describe("terminal progress subscriber", () => {
  test("a turn paints indeterminate progress and idle clears it", () => {
    const emitted: TerminalProgressState[] = [];
    const stop = startTerminalProgressSubscriber((state) => emitted.push(state));

    setBusy(true);
    expect(emitted).toEqual(["indeterminate"]);

    setBusy(false);
    expect(emitted).toEqual(["indeterminate", "completed"]);
    stop();
  });

  test("repeated store events without a busy transition emit nothing", () => {
    const emitted: TerminalProgressState[] = [];
    const stop = startTerminalProgressSubscriber((state) => emitted.push(state));

    setBusy(true);
    setBusy(true);
    dispatch({
      type: "view/setVerboseTranscript",
      verbose: appStore.getState().view.verboseTranscript,
    });
    expect(emitted).toEqual(["indeterminate"]);
    stop();
  });

  test("disposing clears the progress surface and stops listening", () => {
    const emitted: TerminalProgressState[] = [];
    const stop = startTerminalProgressSubscriber((state) => emitted.push(state));

    setBusy(true);
    stop();
    expect(emitted).toEqual(["indeterminate", "completed"]);

    setBusy(false);
    expect(emitted).toEqual(["indeterminate", "completed"]);
  });
});
