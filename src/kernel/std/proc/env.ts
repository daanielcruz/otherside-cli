import fs from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import memoize from "lodash-es/memoize.js";
import { findExecutable } from "@/kernel/std/proc/find-executable.ts";
import { which } from "@/kernel/std/proc/which.ts";

export function isEnvTruthy(envVar: string | boolean | undefined): boolean {
  if (!envVar) return false;
  if (typeof envVar === "boolean") return envVar;
  const normalizedValue = envVar.toLowerCase().trim();
  return ["1", "true", "yes", "on"].includes(normalizedValue);
}

export function isEnvDefinedFalsy(envVar: string | boolean | undefined): boolean {
  if (envVar === undefined) return false;
  if (typeof envVar === "boolean") return !envVar;
  if (!envVar) return false;
  const normalizedValue = envVar.toLowerCase().trim();
  return ["0", "false", "no", "off"].includes(normalizedValue);
}

export const getLocalConfigHomeDir = memoize(
  (): string => {
    return (process.env.OTHERSIDE_CONFIG_DIR ?? join(homedir(), ".otherside")).normalize("NFC");
  },
  () => process.env.OTHERSIDE_CONFIG_DIR,
);

export function getTeamsDir(): string {
  return join(getLocalConfigHomeDir(), "teams");
}

export function hasNodeOption(flag: string): boolean {
  const nodeOptions = process.env.NODE_OPTIONS;
  if (!nodeOptions) {
    return false;
  }
  return nodeOptions.split(/\s+/).includes(flag);
}

export function isMinimalUIMode(): boolean {
  return isEnvTruthy(process.env.OTHERSIDE_SIMPLE) || process.argv.includes("--bare");
}

// A restricted launch posture: on-disk user/project workflow scripts are not
// resolved or runnable, only the bundled built-ins are. Read as env OR argv so
// the gate holds even before the CLI arg pass mirrors the flag to the env, and
// so dispatched sub-sessions (which inherit env, not argv) stay restricted too.
export function isSafeMode(): boolean {
  return isEnvTruthy(process.env.OTHERSIDE_SAFE_MODE) || process.argv.includes("--safe-mode");
}

export function parseEnvVars(rawEnvArgs: string[] | undefined): Record<string, string> {
  const parsedEnv: Record<string, string> = {};

  if (rawEnvArgs) {
    for (const envStr of rawEnvArgs) {
      const [key, ...valueParts] = envStr.split("=");
      if (!key || valueParts.length === 0) {
        throw new Error(
          `Invalid environment variable format: ${envStr}, environment variables should be added as: -e KEY1=value1 -e KEY2=value2`,
        );
      }
      parsedEnv[key] = valueParts.join("=");
    }
  }
  return parsedEnv;
}

export function getAWSRegion(): string {
  return process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-east-1";
}

export function shouldPreserveShellWorkingDir(): boolean {
  return isEnvTruthy(process.env.OTHERSIDE_BASH_MAINTAIN_PROJECT_WORKING_DIR);
}

export function isRunningInManagedEnvironment(): boolean {
  return false;
}

type Platform = "win32" | "darwin" | "linux";

const hasInternetAccess = memoize(async (): Promise<boolean> => {
  try {
    const { default: axiosClient } = await import("axios");
    await axiosClient.head("http://1.1.1.1", {
      signal: AbortSignal.timeout(1000),
    });
    return true;
  } catch {
    return false;
  }
});

export function isRuntimeBun(): boolean {
  return process.versions.bun !== undefined;
}

async function isCommandAvailable(command: string): Promise<boolean> {
  try {
    return !!(await which(command));
  } catch {
    return false;
  }
}

const detectPackageManagers = memoize(async (): Promise<string[]> => {
  const packageManagers = [];

  if (await isCommandAvailable("npm")) packageManagers.push("npm");
  if (await isCommandAvailable("yarn")) packageManagers.push("yarn");
  if (await isCommandAvailable("pnpm")) packageManagers.push("pnpm");

  return packageManagers;
});

const detectRuntimes = memoize(async (): Promise<string[]> => {
  const runtimes = [];

  if (await isCommandAvailable("bun")) runtimes.push("bun");
  if (await isCommandAvailable("deno")) runtimes.push("deno");
  if (await isCommandAvailable("node")) runtimes.push("node");

  return runtimes;
});

const isWslEnvironment = memoize((): boolean => {
  try {
    return fs.existsSync("/proc/sys/fs/binfmt_misc/WSLInterop");
  } catch (_error) {
    return false;
  }
});

const isNpmFromWindowsPath = memoize((): boolean => {
  try {
    if (!isWslEnvironment()) {
      return false;
    }

    const { cmd } = findExecutable("npm", []);

    return cmd.startsWith("/mnt/c/");
  } catch (_error) {
    return false;
  }
});

function isConductor(): boolean {
  return process.env.__CFBundleIdentifier === "com.conductor.app";
}

export const JETBRAINS_IDES = [
  "pycharm",
  "intellij",
  "webstorm",
  "phpstorm",
  "rubymine",
  "clion",
  "goland",
  "rider",
  "datagrip",
  "appcode",
  "dataspell",
  "aqua",
  "gateway",
  "fleet",
  "jetbrains",
  "androidstudio",
];

function detectTerminal(): string | undefined {
  if (process.env.CURSOR_TRACE_ID) return "cursor";

  if (process.env.VSCODE_GIT_ASKPASS_MAIN?.includes("cursor")) {
    return "cursor";
  }
  if (process.env.VSCODE_GIT_ASKPASS_MAIN?.includes("windsurf")) {
    return "windsurf";
  }
  if (process.env.VSCODE_GIT_ASKPASS_MAIN?.includes("antigravity")) {
    return "antigravity";
  }
  const bundleId = process.env.__CFBundleIdentifier?.toLowerCase();
  if (bundleId?.includes("vscodium")) return "codium";
  if (bundleId?.includes("windsurf")) return "windsurf";
  if (bundleId?.includes("com.google.android.studio")) return "androidstudio";

  if (bundleId) {
    for (const ide of JETBRAINS_IDES) {
      if (bundleId.includes(ide)) return ide;
    }
  }

  if (process.env.VisualStudioVersion) {
    return "visualstudio";
  }

  if (process.env.TERMINAL_EMULATOR === "JetBrains-JediTerm") {
    if (process.platform === "darwin") return "pycharm";

    return "pycharm";
  }

  if (process.env.TERM === "xterm-ghostty") {
    return "ghostty";
  }
  if (process.env.TERM?.includes("kitty")) {
    return "kitty";
  }

  if (process.env.TERM_PROGRAM) {
    return process.env.TERM_PROGRAM;
  }

  if (process.env.TMUX) return "tmux";
  if (process.env.STY) return "screen";

  if (process.env.KONSOLE_VERSION) return "konsole";
  if (process.env.GNOME_TERMINAL_SERVICE) return "gnome-terminal";
  if (process.env.XTERM_VERSION) return "xterm";
  if (process.env.VTE_VERSION) return "vte-based";
  if (process.env.TERMINATOR_UUID) return "terminator";
  if (process.env.KITTY_WINDOW_ID) {
    return "kitty";
  }
  if (process.env.ALACRITTY_LOG) return "alacritty";
  if (process.env.TILIX_ID) return "tilix";

  if (process.env.WT_SESSION) return "windows-terminal";
  if (process.env.SESSIONNAME && process.env.TERM === "cygwin") return "cygwin";
  if (process.env.MSYSTEM) return process.env.MSYSTEM.toLowerCase();
  if (process.env.ConEmuANSI || process.env.ConEmuPID || process.env.ConEmuTask) {
    return "conemu";
  }

  if (process.env.WSL_DISTRO_NAME) return `wsl-${process.env.WSL_DISTRO_NAME}`;

  if (isSSHSession()) {
    return "ssh-session";
  }

  if (process.env.TERM) {
    const term = process.env.TERM;
    if (term.includes("alacritty")) return "alacritty";
    if (term.includes("rxvt")) return "rxvt";
    if (term.includes("termite")) return "termite";
    return process.env.TERM;
  }

  if (!process.stdout.isTTY) return "non-interactive";

  return undefined;
}

export const detectDeploymentEnvironment = memoize((): string => {
  if (isEnvTruthy(process.env.CODESPACES)) return "codespaces";
  if (process.env.GITPOD_WORKSPACE_ID) return "gitpod";
  if (process.env.REPL_ID || process.env.REPL_SLUG) return "replit";
  if (process.env.PROJECT_DOMAIN) return "glitch";

  if (isEnvTruthy(process.env.VERCEL)) return "vercel";
  if (process.env.RAILWAY_ENVIRONMENT_NAME || process.env.RAILWAY_SERVICE_NAME) {
    return "railway";
  }
  if (isEnvTruthy(process.env.RENDER)) return "render";
  if (isEnvTruthy(process.env.NETLIFY)) return "netlify";
  if (process.env.DYNO) return "heroku";
  if (process.env.FLY_APP_NAME || process.env.FLY_MACHINE_ID) return "fly.io";
  if (isEnvTruthy(process.env.CF_PAGES)) return "cloudflare-pages";
  if (process.env.DENO_DEPLOYMENT_ID) return "deno-deploy";
  if (process.env.AWS_LAMBDA_FUNCTION_NAME) return "aws-lambda";
  if (process.env.AWS_EXECUTION_ENV === "AWS_ECS_FARGATE") return "aws-fargate";
  if (process.env.AWS_EXECUTION_ENV === "AWS_ECS_EC2") return "aws-ecs";

  try {
    const uuid = fs.readFileSync("/sys/hypervisor/uuid", { encoding: "utf8" }).trim().toLowerCase();
    if (uuid.startsWith("ec2")) return "aws-ec2";
  } catch {}
  if (process.env.K_SERVICE) return "gcp-cloud-run";
  if (process.env.GOOGLE_CLOUD_PROJECT) return "gcp";
  if (process.env.WEBSITE_SITE_NAME || process.env.WEBSITE_SKU) return "azure-app-service";
  if (process.env.AZURE_FUNCTIONS_ENVIRONMENT) return "azure-functions";
  if (process.env.APP_URL?.includes("ondigitalocean.app")) {
    return "digitalocean-app-platform";
  }
  if (process.env.SPACE_CREATOR_USER_ID) return "huggingface-spaces";

  if (isEnvTruthy(process.env.GITHUB_ACTIONS)) return "github-actions";
  if (isEnvTruthy(process.env.GITLAB_CI)) return "gitlab-ci";
  if (process.env.CIRCLECI) return "circleci";
  if (process.env.BUILDKITE) return "buildkite";
  if (isEnvTruthy(process.env.CI)) return "ci";

  if (process.env.KUBERNETES_SERVICE_HOST) return "kubernetes";
  try {
    if (fs.existsSync("/.dockerenv")) return "docker";
  } catch {}

  if (env.platform === "darwin") return "unknown-darwin";
  if (env.platform === "linux") return "unknown-linux";
  if (env.platform === "win32") return "unknown-win32";

  return "unknown";
});

function isSSHSession(): boolean {
  return !!(process.env.SSH_CONNECTION || process.env.SSH_CLIENT || process.env.SSH_TTY);
}

export const env = {
  hasInternetAccess,
  isCI: isEnvTruthy(process.env.CI),
  platform: (["win32", "darwin"].includes(process.platform)
    ? process.platform
    : "linux") as Platform,
  arch: process.arch,
  nodeVersion: process.version,
  terminal: detectTerminal(),
  isSSH: isSSHSession,
  getPackageManagers: detectPackageManagers,
  getRuntimes: detectRuntimes,
  isRuntimeBun: memoize(isRuntimeBun),
  isWslEnvironment,
  isNpmFromWindowsPath,
  isConductor,
  detectDeploymentEnvironment,
};
