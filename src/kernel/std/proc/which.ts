import { execSync } from "node:child_process";
import { execa } from "execa";

async function whichNodeAsync(command: string): Promise<string | null> {
  if (process.platform === "win32") {
    const result = await execa(`where.exe ${command}`, {
      shell: true,
      stderr: "ignore",
      reject: false,
    });
    if (result.exitCode !== 0 || !result.stdout) {
      return null;
    }
    return result.stdout.trim().split(/\r?\n/)[0] || null;
  }

  const result = await execa(`which ${command}`, {
    shell: true,
    stderr: "ignore",
    reject: false,
  });
  if (result.exitCode !== 0 || !result.stdout) {
    return null;
  }
  return result.stdout.trim();
}

function whichNodeSync(command: string): string | null {
  if (process.platform === "win32") {
    try {
      const result = execSync(`where.exe ${command}`, {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      const output = result.toString().trim();
      return output.split(/\r?\n/)[0] || null;
    } catch {
      return null;
    }
  }

  try {
    const result = execSync(`which ${command}`, {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return result.toString().trim() || null;
  } catch {
    return null;
  }
}

const bunWhich = typeof Bun !== "undefined" && typeof Bun.which === "function" ? Bun.which : null;

export const which: (command: string) => Promise<string | null> = bunWhich
  ? async (command) => bunWhich(command)
  : whichNodeAsync;

export const whichSync: (command: string) => string | null = bunWhich ?? whichNodeSync;
