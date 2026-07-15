import { renderNativeStatusline, type StatuslineInput } from "@/ui/chrome/status/line-input.ts";

export async function runStatuslineMode(): Promise<void> {
  const raw = await readAllStdin();
  const input = parseStatuslineInput(raw);
  if (input !== null) {
    process.stdout.write(`${renderNativeStatusline(input)}\n`);
  }
}

function readAllStdin(): Promise<string> {
  if (process.stdin.isTTY) return Promise.resolve("");
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(data));
  });
}

function parseStatuslineInput(raw: string): StatuslineInput | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  try {
    return JSON.parse(trimmed) as StatuslineInput;
  } catch {
    return null;
  }
}
