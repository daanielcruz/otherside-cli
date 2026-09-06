import { spawnSync } from "node:child_process";

type SessionControlModeSources = {
  environment: () => NodeJS.ProcessEnv;
  queryClient: () => boolean;
};

function readClientControlMode(): boolean {
  try {
    const result = spawnSync("tmux", ["display-message", "-p", "#{client_control_mode}"], {
      encoding: "utf8",
      timeout: 2000,
    });
    return result.status === 0 && result.stdout.trim() === "1";
  } catch {
    return false;
  }
}

function environmentEnablesControlMode(environment: NodeJS.ProcessEnv): boolean {
  if (!environment.TMUX || environment.TERM_PROGRAM !== "iTerm.app") return false;
  const termValue = environment.TERM ?? "";
  return !termValue.startsWith("screen") && !termValue.startsWith("tmux");
}

export function createSessionControlModeReader({
  environment,
  queryClient,
}: SessionControlModeSources): () => boolean {
  let cached: boolean | undefined;
  return () => {
    if (cached !== undefined) return cached;

    const currentEnvironment = environment();
    cached = environmentEnablesControlMode(currentEnvironment);
    if (cached || !currentEnvironment.TMUX || currentEnvironment.TERM_PROGRAM) return cached;

    cached = queryClient();
    return cached;
  };
}

export const isSessionControlMode = createSessionControlModeReader({
  environment: () => process.env,
  queryClient: readClientControlMode,
});
