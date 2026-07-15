import { describe, expect, it } from "bun:test";
import { initialViewSlice, viewReducer } from "@/store/app-store/slices/view.ts";

describe("viewReducer", () => {
  describe("logEpoch", () => {
    it("bumpLogEpoch increments by 1", () => {
      const next = viewReducer(initialViewSlice, { type: "view/bumpLogEpoch" });
      expect(next.logEpoch).toBe(1);
    });

    it("bumpLogEpoch is monotonic across multiple bumps", () => {
      let state = initialViewSlice;
      for (let i = 0; i < 5; i++) {
        state = viewReducer(state, { type: "view/bumpLogEpoch" });
      }
      expect(state.logEpoch).toBe(5);
    });

    it("bumpLogEpoch creates new state object (DISPLACING trigger)", () => {
      const next = viewReducer(initialViewSlice, { type: "view/bumpLogEpoch" });
      const { logEpoch: nextLogEpoch, ...nextRest } = next;
      const { logEpoch: initialLogEpoch, ...initialRest } = initialViewSlice;

      expect(next).not.toBe(initialViewSlice);
      expect(nextLogEpoch).toBe(initialLogEpoch + 1);
      expect(nextRest).toEqual(initialRest);
    });
  });

  describe("turnTipIndex", () => {
    it("setTurnTipIndex updates index", () => {
      const next = viewReducer(initialViewSlice, { type: "view/setTurnTipIndex", index: 42 });
      expect(next.turnTipIndex).toBe(42);
    });

    it("setTurnTipIndex returns SAME state when value unchanged (identity preservation)", () => {
      const seeded = viewReducer(initialViewSlice, { type: "view/setTurnTipIndex", index: 7 });
      const again = viewReducer(seeded, { type: "view/setTurnTipIndex", index: 7 });
      expect(again).toBe(seeded);
    });

    it("setTurnTipIndex accepts null", () => {
      const seeded = viewReducer(initialViewSlice, { type: "view/setTurnTipIndex", index: 3 });
      const cleared = viewReducer(seeded, { type: "view/setTurnTipIndex", index: null });
      expect(cleared.turnTipIndex).toBeNull();
    });
  });

  describe("contextWarningSuppressed", () => {
    it("setContextWarningSuppressed flips the boolean", () => {
      const on = viewReducer(initialViewSlice, {
        type: "view/setContextWarningSuppressed",
        suppressed: true,
      });
      expect(on.contextWarningSuppressed).toBe(true);
      const off = viewReducer(on, { type: "view/setContextWarningSuppressed", suppressed: false });
      expect(off.contextWarningSuppressed).toBe(false);
    });

    it("setContextWarningSuppressed preserves identity when unchanged", () => {
      const seeded = viewReducer(initialViewSlice, {
        type: "view/setContextWarningSuppressed",
        suppressed: true,
      });
      const again = viewReducer(seeded, {
        type: "view/setContextWarningSuppressed",
        suppressed: true,
      });
      expect(again).toBe(seeded);
    });
  });

  describe("isTurnRunning", () => {
    it("setTurnRunning flips the flag", () => {
      const running = viewReducer(initialViewSlice, {
        type: "view/setTurnRunning",
        running: true,
      });
      expect(running.isTurnRunning).toBe(true);
    });

    it("setTurnRunning preserves identity when unchanged", () => {
      const seeded = viewReducer(initialViewSlice, {
        type: "view/setTurnRunning",
        running: false,
      });
      expect(seeded).toBe(initialViewSlice);
    });
  });

  describe("panelFocus", () => {
    it("setPanelFocus sets the focus string", () => {
      const next = viewReducer(initialViewSlice, {
        type: "view/setPanelFocus",
        focus: "agents",
      });
      expect(next.panelFocus).toBe("agents");
    });

    it("setPanelFocus preserves identity when unchanged", () => {
      const seeded = viewReducer(initialViewSlice, {
        type: "view/setPanelFocus",
        focus: "ask",
      });
      const again = viewReducer(seeded, { type: "view/setPanelFocus", focus: "ask" });
      expect(again).toBe(seeded);
    });

    it("setPanelFocus accepts null to clear focus", () => {
      const seeded = viewReducer(initialViewSlice, {
        type: "view/setPanelFocus",
        focus: "tasks",
      });
      const cleared = viewReducer(seeded, { type: "view/setPanelFocus", focus: null });
      expect(cleared.panelFocus).toBeNull();
    });
  });

  describe("spinnerMode + turnVerb + thinkingStatus", () => {
    it("setSpinnerMode/setTurnVerb/setThinkingStatus all preserve identity when unchanged", () => {
      const s1 = viewReducer(initialViewSlice, {
        type: "view/setSpinnerMode",
        mode: "requesting",
      });
      expect(s1).toBe(initialViewSlice);
      const s2 = viewReducer(initialViewSlice, { type: "view/setTurnVerb", verb: "Thinking" });
      expect(s2).toBe(initialViewSlice);
      const s3 = viewReducer(initialViewSlice, {
        type: "view/setThinkingStatus",
        status: null,
      });
      expect(s3).toBe(initialViewSlice);
    });

    it("transitions across spinnerMode values land", () => {
      const responding = viewReducer(initialViewSlice, {
        type: "view/setSpinnerMode",
        mode: "responding",
      });
      const thinking = viewReducer(responding, {
        type: "view/setSpinnerMode",
        mode: "thinking",
      });
      expect(responding.spinnerMode).toBe("responding");
      expect(thinking.spinnerMode).toBe("thinking");
    });
  });

  describe("session-migrated lower-panel state", () => {
    it("setWorkflowDetailTarget sets + clears the id, preserves identity when unchanged", () => {
      const set = viewReducer(initialViewSlice, {
        type: "view/setWorkflowDetailTarget",
        id: "wf_1",
      });
      expect(set.workflowDetailTargetId).toBe("wf_1");
      expect(viewReducer(set, { type: "view/setWorkflowDetailTarget", id: "wf_1" })).toBe(set);
      const cleared = viewReducer(set, { type: "view/setWorkflowDetailTarget", id: null });
      expect(cleared.workflowDetailTargetId).toBeNull();
    });

    it("setBtwMode flips active, preserves identity when unchanged", () => {
      const on = viewReducer(initialViewSlice, { type: "view/setBtwMode", active: true });
      expect(on.btwMode).toBe(true);
      expect(viewReducer(on, { type: "view/setBtwMode", active: true })).toBe(on);
    });

    it("setBgPillFocused flips focused, preserves identity when unchanged", () => {
      const on = viewReducer(initialViewSlice, { type: "view/setBgPillFocused", focused: true });
      expect(on.bgPillFocused).toBe(true);
      expect(viewReducer(initialViewSlice, { type: "view/setBgPillFocused", focused: false })).toBe(
        initialViewSlice,
      );
    });

    it("setPanelFocused flips focused", () => {
      const on = viewReducer(initialViewSlice, { type: "view/setPanelFocused", focused: true });
      expect(on.panelFocused).toBe(true);
      expect(viewReducer(on, { type: "view/setPanelFocused", focused: true })).toBe(on);
    });

    it("setPanelSelection sets the index, preserves identity when unchanged", () => {
      const set = viewReducer(initialViewSlice, { type: "view/setPanelSelection", value: 3 });
      expect(set.panelSelection).toBe(3);
      expect(viewReducer(set, { type: "view/setPanelSelection", value: 3 })).toBe(set);
    });

    it("setTasksExpanded flips value", () => {
      const on = viewReducer(initialViewSlice, { type: "view/setTasksExpanded", value: true });
      expect(on.tasksExpanded).toBe(true);
      expect(viewReducer(on, { type: "view/setTasksExpanded", value: true })).toBe(on);
    });

    it("setBgTasksOpen flips open, preserves identity when unchanged", () => {
      const open = viewReducer(initialViewSlice, { type: "view/setBgTasksOpen", open: true });
      expect(open.bgTasksOpen).toBe(true);
      expect(viewReducer(open, { type: "view/setBgTasksOpen", open: true })).toBe(open);
    });

    it("setConfigInitialTab sets the tab, accepts undefined", () => {
      const details = viewReducer(initialViewSlice, {
        type: "view/setConfigInitialTab",
        tab: "details",
      });
      expect(details.configInitialTab).toBe("details");
      const cleared = viewReducer(details, { type: "view/setConfigInitialTab", tab: undefined });
      expect(cleared.configInitialTab).toBeUndefined();
    });

    it("setBusy flips the flag, preserves identity when unchanged", () => {
      const busy = viewReducer(initialViewSlice, { type: "view/setBusy", busy: true });
      expect(busy.busy).toBe(true);
      expect(viewReducer(busy, { type: "view/setBusy", busy: true })).toBe(busy);
    });

    it("setProgressStartedAt sets the timestamp, accepts null", () => {
      const set = viewReducer(initialViewSlice, {
        type: "view/setProgressStartedAt",
        startedAt: 123456,
      });
      expect(set.progressStartedAt).toBe(123456);
      const cleared = viewReducer(set, { type: "view/setProgressStartedAt", startedAt: null });
      expect(cleared.progressStartedAt).toBeNull();
    });
  });
});
