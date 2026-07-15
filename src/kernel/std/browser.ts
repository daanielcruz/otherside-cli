import { getPlatform } from "@/kernel/std/proc/platform.ts";

export async function openBrowser(url: string): Promise<void> {
  const platform = getPlatform();
  try {
    if (platform === "macos") {
      Bun.spawn(["open", url], { stdout: "ignore", stderr: "ignore" });
      return;
    }
    if (platform === "windows") {
      Bun.spawn(["rundll32.exe", "url.dll,FileProtocolHandler", url], {
        stdout: "ignore",
        stderr: "ignore",
      });
      return;
    }
    Bun.spawn(["xdg-open", url], { stdout: "ignore", stderr: "ignore" });
  } catch {}
}
