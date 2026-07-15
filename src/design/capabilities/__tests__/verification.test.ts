import { describe, expect, it } from "bun:test";
import {
  clearVerificationQueue,
  drainVerificationPaths,
  enqueueVerification,
  formatLoadReport,
  ReadyForVerificationTool,
} from "@/design/capabilities/verification-tools.ts";
import { registerDesignFork, unregisterDesignFork } from "@/design/fork-context.ts";
import { resolveLoadReport } from "@/design/pending.ts";
import type { DesignSnapshot, JsonRpcNotification } from "@/design/types.ts";
import { finalVerdict, makeVerifierTools, type VerifierRunState } from "@/design/verifier.ts";
import type { ToolCall } from "@/kernel/std/types/message.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";

const DESIGN_ID = "design-verification-test";

function makeSnapshot(paths: string[]): DesignSnapshot {
  return {
    designId: DESIGN_ID,
    messages: [],
    files: paths.map((path) => ({
      path,
      content: "<html></html>",
      status: "generated",
      language: "html",
      kind: "html",
      displayName: path,
      typeLabel: ".os.html",
      updatedAt: new Date().toISOString(),
    })),
    artifacts: [],
    viewState: { activeFileTab: paths[0] ?? null, openFiles: paths },
    designSystem: null,
    status: "completed",
    updatedAt: new Date().toISOString(),
  } as unknown as DesignSnapshot;
}

function withFork(
  forkId: string,
  snapshot: DesignSnapshot,
  emitted: JsonRpcNotification[],
): RequestContext {
  registerDesignFork(forkId, {
    designId: DESIGN_ID,
    cwd: "/tmp",
    snapshots: new Map([[DESIGN_ID, snapshot]]),
    emit: (notification) => emitted.push(notification),
  });
  return { agentOwnerId: forkId } as RequestContext;
}

function call(input: unknown): ToolCall {
  return { id: `call-${Math.random().toString(36).slice(2)}`, name: "test", input } as ToolCall;
}

describe("formatLoadReport", () => {
  it("quotes every diagnostic line and closes with the terminator", () => {
    const text = formatLoadReport(
      "home.os.html",
      { ok: false, errors: ["TypeError: boom"], logs: ["warn: slow asset"] },
      false,
    );
    expect(text).toContain("> TypeError: boom");
    expect(text).toContain("> warn: slow asset");
    expect(text).toContain("END OF LOAD REPORT");
    expect(text).toContain("Load reported errors");
    expect(text).toContain("the verifier is not run on a dirty load");
  });

  it("clean load announces the background verifier", () => {
    const text = formatLoadReport("home.os.html", { ok: true, errors: [], logs: [] }, false);
    expect(text).toContain("> (no console output)");
    expect(text).toContain("END OF LOAD REPORT");
    expect(text).toContain("A verifier will check this file in the background");
  });

  it("clean load with skip_verifier_agent skips the verifier", () => {
    const text = formatLoadReport("home.os.html", { ok: true, errors: [], logs: [] }, true);
    expect(text).toContain("Verifier skipped");
    expect(text).not.toContain("A verifier will check this file");
  });

  it("a missing report is stated as unverified, never as a clean load", () => {
    const text = formatLoadReport("home.os.html", null, false);
    expect(text).toContain("> (no load report: web preview unavailable)");
    expect(text).toContain("UNVERIFIED");
    expect(text).toContain("A verifier will still check this file");
    expect(text).not.toContain("Load is clean");
  });

  it("a missing report with skip_verifier_agent tells the user the screen is unchecked", () => {
    const text = formatLoadReport("home.os.html", null, true);
    expect(text).toContain("UNVERIFIED");
    expect(text).toContain("could not be checked");
    expect(text).not.toContain("Load is clean");
  });
});

describe("verification queue", () => {
  it("dedupes by path and drains once", () => {
    clearVerificationQueue(DESIGN_ID);
    enqueueVerification(DESIGN_ID, "a.os.html");
    enqueueVerification(DESIGN_ID, "b.os.html");
    enqueueVerification(DESIGN_ID, "a.os.html");
    expect(drainVerificationPaths(DESIGN_ID)).toEqual(["b.os.html", "a.os.html"]);
    expect(drainVerificationPaths(DESIGN_ID)).toEqual([]);
  });
});

describe("ready_for_verification", () => {
  it("errors on an unknown screen path", async () => {
    const forkId = "fork-rfv-unknown";
    const ctx = withFork(forkId, makeSnapshot(["home.os.html"]), []);
    try {
      const result = await ReadyForVerificationTool.run(call({ path: "missing.os.html" }), ctx);
      expect(result.is_error).toBe(true);
      expect(result.content).toContain("no such screen");
    } finally {
      unregisterDesignFork(forkId);
    }
  });

  it("returns the formatted report and queues the screen on a clean load", async () => {
    clearVerificationQueue(DESIGN_ID);
    const forkId = "fork-rfv-clean";
    const emitted: JsonRpcNotification[] = [];
    const ctx = withFork(forkId, makeSnapshot(["home.os.html"]), emitted);
    try {
      const pending = ReadyForVerificationTool.run(call({ path: "home.os.html" }), ctx);
      // The tool emitted $/load-report-request; answer it like the web would.
      const request = emitted.find((n) => n.method === "$/load-report-request");
      expect(request).toBeDefined();
      const requestId = (request?.params as { requestId: string }).requestId;
      resolveLoadReport(requestId, { ok: true, errors: [], logs: ["painted in 120ms"] });
      const result = await pending;
      expect(result.is_error).toBeUndefined();
      expect(result.content).toContain("> painted in 120ms");
      expect(result.content).toContain("END OF LOAD REPORT");
      expect(drainVerificationPaths(DESIGN_ID)).toEqual(["home.os.html"]);
    } finally {
      unregisterDesignFork(forkId);
    }
  });

  it("still queues the verifier when the load report never arrives", async () => {
    clearVerificationQueue(DESIGN_ID);
    const forkId = "fork-rfv-unavailable";
    const emitted: JsonRpcNotification[] = [];
    const ctx = withFork(forkId, makeSnapshot(["home.os.html"]), emitted);
    try {
      const pending = ReadyForVerificationTool.run(call({ path: "home.os.html" }), ctx);
      const request = emitted.find((n) => n.method === "$/load-report-request");
      const requestId = (request?.params as { requestId: string }).requestId;
      resolveLoadReport(requestId, null);
      const result = await pending;
      expect(result.content).toContain("UNVERIFIED");
      expect(result.content).not.toContain("Load is clean");
      expect(drainVerificationPaths(DESIGN_ID)).toEqual(["home.os.html"]);
    } finally {
      unregisterDesignFork(forkId);
    }
  });

  it("does not queue on a dirty load", async () => {
    clearVerificationQueue(DESIGN_ID);
    const forkId = "fork-rfv-dirty";
    const emitted: JsonRpcNotification[] = [];
    const ctx = withFork(forkId, makeSnapshot(["home.os.html"]), emitted);
    try {
      const pending = ReadyForVerificationTool.run(call({ path: "home.os.html" }), ctx);
      const request = emitted.find((n) => n.method === "$/load-report-request");
      const requestId = (request?.params as { requestId: string }).requestId;
      resolveLoadReport(requestId, { ok: false, errors: ["ReferenceError: x"], logs: [] });
      const result = await pending;
      expect(result.content).toContain("> ReferenceError: x");
      expect(drainVerificationPaths(DESIGN_ID)).toEqual([]);
    } finally {
      unregisterDesignFork(forkId);
    }
  });
});

describe("verifier verdict state", () => {
  it("verification_feedback records the verdict", async () => {
    const state: VerifierRunState = { lastShownPath: null, verdict: null, description: "" };
    const tools = makeVerifierTools(state);
    const feedback = tools.find((tool) => tool.schema.name === "verification_feedback");
    expect(feedback).toBeDefined();
    const result = await feedback?.run(
      call({ verdict: "needs_work", description: "header clipped at 320px" }),
      {} as RequestContext,
    );
    expect(result?.is_error).toBeUndefined();
    expect(finalVerdict(state)).toEqual({
      verdict: "needs_work",
      description: "header clipped at 320px",
    });
  });

  it("needs_work without a description is rejected", async () => {
    const state: VerifierRunState = { lastShownPath: null, verdict: null, description: "" };
    const tools = makeVerifierTools(state);
    const feedback = tools.find((tool) => tool.schema.name === "verification_feedback");
    const result = await feedback?.run(call({ verdict: "needs_work" }), {} as RequestContext);
    expect(result?.is_error).toBe(true);
    expect(state.verdict).toBeNull();
  });

  it("a verifier that never reports is inconclusive, not done", () => {
    const state: VerifierRunState = { lastShownPath: null, verdict: null, description: "" };
    expect(finalVerdict(state)).toEqual({
      verdict: "inconclusive",
      description: "(verifier ended without a verdict)",
    });
  });

  it("diagnostics before show_html are rejected", async () => {
    const state: VerifierRunState = { lastShownPath: null, verdict: null, description: "" };
    const tools = makeVerifierTools(state);
    const logs = tools.find((tool) => tool.schema.name === "get_webview_logs");
    const forkId = "fork-verifier-logs";
    const ctx = withFork(forkId, makeSnapshot(["home.os.html"]), []);
    try {
      const result = await logs?.run(call({}), ctx);
      expect(result?.is_error).toBe(true);
      expect(result?.content).toContain("call show_html first");
    } finally {
      unregisterDesignFork(forkId);
    }
  });
});
