import { getPlatform } from "@/kernel/std/proc/platform.ts";

export async function openBrowser(url: string): Promise<void> {
  const platform = getPlatform();
  try {
    if (platform === "macos") {
      // `-u` treats the arg as a URL (avoids path/option misparse on long OAuth URLs).
      Bun.spawn(["open", "-u", url], { stdout: "ignore", stderr: "ignore" });
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
