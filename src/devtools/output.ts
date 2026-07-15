import { devtoolBoolean } from "@/devtools/settings.ts";

export function emitDiagnosticOutput(...parts: unknown[]): void {
  if (!devtoolBoolean("diagnosticOutput")) return;
  process.stderr.write(
    parts.map((part) => (typeof part === "string" ? part : JSON.stringify(part))).join(" ") + "\n",
  );
}

export function writeDebugError(...parts: unknown[]): void {
  if (!devtoolBoolean("diagnosticOutput")) return;
  process.stderr.write(
    parts
      .map((part) =>
        typeof part === "string"
          ? part
          : part instanceof Error
            ? `${part.message}\n${part.stack ?? ""}`
            : JSON.stringify(part),
      )
      .join(" ") + "\n",
  );
}
