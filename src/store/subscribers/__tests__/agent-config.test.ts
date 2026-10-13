import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, type UserConfig, updateConfig } from "@/kernel/config/config.ts";
import { consumeInternalWrite, forgetInternalWrites } from "@/kernel/config/internal-writes.ts";
import * as resolver from "@/kernel/config/resolver.ts";
import { projectSettingsPath, userSettingsPath } from "@/kernel/config/scope.ts";
import {
  onSettingsChanged,
  SETTLE_MS,
  type SettingsChange,
  type SettingsWatchOptions,
  stopWatchingSettings,
  watchSettingsFiles,
} from "@/kernel/config/settings-watch.ts";
import { startAgentConfigSubscriber } from "@/store/subscribers/agent-config.ts";

let root: string;
let projectDir: string;
let priorConfigDir: string | undefined;
let priorPolicyDir: string | undefined;
const teardowns: Array<() => void> = [];

beforeEach(() => {
  priorConfigDir = process.env.OTHERSIDE_CONFIG_DIR;
  priorPolicyDir = process.env.OTHERSIDE_POLICY_DIR;
  root = mkdtempSync(join(tmpdir(), "otherside-agent-config-"));
  projectDir = join(root, "project");
  process.env.OTHERSIDE_CONFIG_DIR = join(root, "config");
  process.env.OTHERSIDE_POLICY_DIR = join(root, "policy");
  mkdirSync(process.env.OTHERSIDE_CONFIG_DIR, { recursive: true });
  mkdirSync(process.env.OTHERSIDE_POLICY_DIR, { recursive: true });
  mkdirSync(join(projectDir, ".otherside"), { recursive: true });
  writeFileSync(userSettingsPath(), JSON.stringify({ language: "Portuguese" }));
});

afterEach(() => {
  stopWatchingSettings();
  for (const teardown of teardowns.splice(0)) teardown();
  forgetInternalWrites();
  if (priorConfigDir === undefined) delete process.env.OTHERSIDE_CONFIG_DIR;
  else process.env.OTHERSIDE_CONFIG_DIR = priorConfigDir;
  if (priorPolicyDir === undefined) delete process.env.OTHERSIDE_POLICY_DIR;
  else process.env.OTHERSIDE_POLICY_DIR = priorPolicyDir;
  rmSync(root, { recursive: true, force: true });
});

function makeAgent() {
  const config: UserConfig = { ...DEFAULT_CONFIG, language: "Portuguese" };
  const deps = { config, session: { cwd: projectDir } };
  return {
    deps,
    updateConfig: mock((config: UserConfig) => {
      deps.config = config;
    }),
  };
}

async function startWatching(
  agent: ReturnType<typeof makeAgent>,
  accept: NonNullable<SettingsWatchOptions["accept"]> = () => true,
) {
  const announced: SettingsChange[] = [];
  const ruled: SettingsChange[] = [];
  const dispose = startAgentConfigSubscriber(agent);
  teardowns.push(
    dispose,
    onSettingsChanged((change) => announced.push(change)),
  );
  watchSettingsFiles(projectDir, {
    accept: (change) => {
      ruled.push(change);
      return accept(change);
    },
  });
  // Drain setup writes that the directory watcher can still deliver after registration.
  await Bun.sleep(SETTLE_MS * 3);
  announced.length = 0;
  ruled.length = 0;
  agent.updateConfig.mockClear();
  return { announced, ruled, dispose };
}

async function until(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error("Settings change was not observed");
    await Bun.sleep(10);
  }
}

describe("agent language settings subscriber", () => {
  test("applies an internal save only after its accepted settings event", async () => {
    const agent = makeAgent();
    const seen = await startWatching(agent, (change) => consumeInternalWrite(change.path));

    await updateConfig((config) => {
      config.language = "Spanish";
    });
    expect(agent.deps.config.language).toBe("Portuguese");
    expect(agent.updateConfig).not.toHaveBeenCalled();

    await until(() => seen.announced.length > 0);
    expect(seen.announced[0]?.scope).toBe("user");
    expect(agent.deps.config.language).toBe("Spanish");
    expect(agent.updateConfig).toHaveBeenCalledTimes(1);
  });

  test("waits for the gate to accept an external edit", async () => {
    const agent = makeAgent();
    const ruling = Promise.withResolvers<boolean>();
    const seen = await startWatching(agent, () => ruling.promise);

    writeFileSync(userSettingsPath(), JSON.stringify({ language: "Spanish" }));
    await until(() => seen.ruled.length > 0);
    expect(seen.announced).toHaveLength(0);
    expect(agent.deps.config.language).toBe("Portuguese");

    ruling.resolve(true);
    await until(() => seen.announced.length > 0);
    expect(agent.deps.config.language).toBe("Spanish");
  });

  test("keeps the current language when an external edit is refused", async () => {
    const agent = makeAgent();
    const current = agent.deps.config;
    const seen = await startWatching(agent, () => false);

    writeFileSync(userSettingsPath(), JSON.stringify({ language: "Spanish" }));
    await until(() => seen.ruled.length > 0);
    expect(seen.announced).toHaveLength(0);
    expect(agent.deps.config).toBe(current);
    expect(agent.updateConfig).not.toHaveBeenCalled();
  });

  test.each([
    "project",
    "local",
    "policy",
  ] as const)("an accepted %s change cannot import a refused user language", async (scope) => {
    const agent = makeAgent();
    const seen = await startWatching(agent, (change) => change.scope !== "user");

    writeFileSync(userSettingsPath(), JSON.stringify({ language: "Spanish" }));
    await until(() => seen.ruled.length > 0);
    expect(seen.announced).toHaveLength(0);

    const path =
      scope === "policy"
        ? join(root, "config", "managed-settings.json")
        : projectSettingsPath(projectDir, scope);
    writeFileSync(path, JSON.stringify({ language: "French" }));
    await until(() => seen.announced.some((change) => change.scope === scope));
    expect(agent.deps.config.language).toBe("Portuguese");
    expect(agent.updateConfig).not.toHaveBeenCalled();
  });

  test("removes the language field after an accepted deletion", async () => {
    const agent = makeAgent();
    const current = agent.deps.config;
    const seen = await startWatching(agent);

    await updateConfig((config) => {
      delete config.language;
    });
    await until(() => seen.announced.length > 0);
    expect(agent.deps.config).not.toHaveProperty("language");
    expect(current.language).toBe("Portuguese");
    expect(agent.updateConfig).toHaveBeenCalledTimes(1);
  });

  test("preserves the latest provider, model, permissions and session overrides", async () => {
    const agent = makeAgent();
    const seen = await startWatching(agent);
    const current: UserConfig = {
      ...agent.deps.config,
      defaultProvider: "openai",
      defaultModel: "session-model",
      defaultMode: "default",
      permissions: { allow: ["Read"], deny: ["Bash"] },
      showThinkingSummaries: false,
      outputStyle: "session-style",
    };
    agent.deps.config = current;

    await updateConfig((config) => {
      config.language = "Spanish";
      config.defaultProvider = "anthropic";
      config.defaultModel = "disk-model";
      config.defaultMode = "accept-edits";
      config.permissions = { allow: ["Bash"] };
      config.showThinkingSummaries = true;
      config.outputStyle = "disk-style";
    });
    await until(() => seen.announced.length > 0);
    expect(agent.deps.config).toEqual({ ...current, language: "Spanish" });
    expect(agent.deps.config.permissions).toBe(current.permissions);
    expect(current.language).toBe("Portuguese");
  });

  test("resolves for the current session cwd and obeys the language scopes", async () => {
    const agent = makeAgent();
    const seen = await startWatching(agent);
    const sessionCwd = join(root, "active-project");
    mkdirSync(join(sessionCwd, ".otherside"), { recursive: true });
    writeFileSync(projectSettingsPath(sessionCwd, "project"), '{"language":"French"}');
    writeFileSync(projectSettingsPath(sessionCwd, "local"), '{"language":"German"}');
    agent.deps.session.cwd = sessionCwd;
    const resolveConfig = spyOn(resolver, "resolveConfig");
    teardowns.push(() => resolveConfig.mockRestore());

    await updateConfig((config) => {
      config.language = "Spanish";
    });
    await until(() => seen.announced.length > 0);
    expect(resolveConfig).toHaveBeenCalledWith(sessionCwd);
    expect(agent.deps.config.language).toBe("Spanish");
  });

  test("does not replace agent config when language is unchanged", async () => {
    const agent = makeAgent();
    const current = agent.deps.config;
    const seen = await startWatching(agent);

    await updateConfig((config) => {
      config.showTips = false;
    });
    await until(() => seen.announced.length > 0);
    expect(agent.deps.config).toBe(current);
    expect(agent.updateConfig).not.toHaveBeenCalled();
  });

  test("disposes its listener without stopping other settings subscribers", async () => {
    const agent = makeAgent();
    const current = agent.deps.config;
    const seen = await startWatching(agent);
    seen.dispose();
    seen.dispose();

    await updateConfig((config) => {
      config.language = "Spanish";
    });
    await until(() => seen.announced.length > 0);
    expect(agent.deps.config).toBe(current);
    expect(agent.updateConfig).not.toHaveBeenCalled();
  });
});
