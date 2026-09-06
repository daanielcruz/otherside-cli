import type { PairHandle, PairResult } from "@/backend/index.ts";
import { renderTextWithStyles } from "@/terminal-runtime/text/color-codes.js";
import type { PairPhase } from "@/ui/panels/remote/data.ts";
import { Color } from "@/ui/theme/theme.ts";

const QR_MIN_ROWS = 38;

export interface PairViewState {
  phase: PairPhase;
  result: PairResult | null;
  error: string | null;
  handle: PairHandle | null;
}

export function pairBodyLines(state: PairViewState, terminalRows: number): string[] {
  if (state.phase === "confirmed") {
    return [
      renderTextWithStyles("Paired", { color: Color.success, bold: true }),
      renderTextWithStyles(`Linked with ${state.result?.peerDeviceId ?? "your device"}.`, {
        color: Color.text,
      }),
      renderTextWithStyles("Remote is now enabled.", { color: Color.muted }),
    ];
  }

  if (state.phase === "failed") {
    const expired = !!state.error && state.error.includes("expired");
    return [
      renderTextWithStyles(expired ? "Pairing code expired" : "Pairing failed", {
        color: expired ? Color.warning : Color.error,
        bold: true,
      }),
      renderTextWithStyles(state.error ?? "unknown error", {
        color: expired ? Color.muted : Color.error,
      }),
      "",
      renderTextWithStyles("Press r to generate a new code.", { color: Color.panelAccent }),
    ];
  }

  if (!state.handle) {
    return [renderTextWithStyles("Preparing pairing code…", { color: Color.muted })];
  }

  const rows = terminalRows;
  const showQr = rows >= QR_MIN_ROWS;
  const expiryMinutes = Math.ceil(state.handle.expiresInSeconds / 60);
  const lines: string[] = [
    renderTextWithStyles(
      "Scan with the otherside app (Settings → Linked devices → Pair new device)",
      { color: Color.muted },
    ),
    "",
    renderTextWithStyles("Approval code", { color: Color.muted }),
    renderTextWithStyles(state.handle.userCode, { color: Color.panelAccent, bold: true }),
    "",
  ];

  if (showQr) {
    for (const line of state.handle.qr.split("\n")) {
      lines.push(line);
    }
  } else {
    lines.push(
      renderTextWithStyles(`Terminal too small for QR (${rows} rows). Resize or set`, {
        color: Color.muted,
      }),
    );
    lines.push(
      renderTextWithStyles("OTHERSIDE_REMOTE_DEBUG_PAYLOAD=1 to paste payload manually.", {
        color: Color.muted,
      }),
    );
  }

  // Debug-only manual transfer. The payload contains public pairing material and
  // the displayed user code, never the secret device code or issued credentials.
  if (process.env.OTHERSIDE_REMOTE_DEBUG_PAYLOAD === "1") {
    lines.push("");
    lines.push(
      renderTextWithStyles("Paste this pairing payload in the app's debug field:", {
        color: Color.muted,
      }),
    );
    lines.push(renderTextWithStyles(state.handle.payload, { color: Color.text }));
  }

  lines.push("");
  lines.push(renderTextWithStyles("Awaiting approval…", { color: Color.panelAccent }));
  lines.push(
    renderTextWithStyles(`Code expires after ${expiryMinutes} min · press r for a new one`, {
      color: Color.muted,
    }),
  );
  return lines;
}
