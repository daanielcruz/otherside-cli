import { spawn as spawnProcess } from "node:child_process";
import { clearDesignSessionAllows } from "@/design/capabilities/llm-stream.ts";
import { startDesignRelay } from "@/design/relay/relay.ts";
import { getBySession, register, stopAll, unregister } from "@/design/spawn-registry.ts";
import { listDesigns } from "@/design/storage.ts";
import type { DesignSpawnHandle } from "@/design/types.ts";
import type { Agent } from "@/engine/queue/index.ts";
import type { Session } from "@/engine/session/index.ts";
import { uuidv4 } from "@/kernel/std/id.ts";
import type { Broker } from "@/store/app-store/broker.ts";

export interface StartDesignArgs {
  broker: Broker;
  session: Session;
  agent: Agent;
  cwd: string;
  version: string;
  initialPrompt?: string | undefined;
}

function openBrowser(url: string): void {
  if (process.env.OTHERSIDE_DESIGN_NO_OPEN === "1") return;
  const platform = process.platform;
  const cmd = platform === "darwin" ? "open" : platform === "win32" ? "cmd" : "xdg-open";
  const args = platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    const child = spawnProcess(cmd, args, {
      stdio: "ignore",
      detached: true,
    });
    child.unref();
  } catch {}
}

export async function startDesign(args: StartDesignArgs): Promise<DesignSpawnHandle> {
  const existing = getBySession(args.session.id);
  if (existing) await existing.stop();
  clearDesignSessionAllows(args.session.id);
  const spawnId = uuidv4();
  const localDesigns = listDesigns(args.cwd);
  const designId = localDesigns.length > 0 ? (localDesigns[0]?.designId ?? uuidv4()) : uuidv4();
  const relay = await startDesignRelay({
    spawnId,
    designId,
    initialPrompt: args.initialPrompt,
    session: args.session,
    agent: args.agent,
    cwd: args.cwd,
    version: args.version,
    broker: args.broker,
  });
  const wrappedStop = async (): Promise<void> => {
    await relay.stop();
    unregister(spawnId);
  };
  const spawn = { ...relay.spawn, stop: wrappedStop };
  register(spawn);
  openBrowser(relay.url);
  return {
    spawnId,
    designId,
    url: relay.url,
    stop: wrappedStop,
  };
}

export async function stopDesign(sessionId: string): Promise<boolean> {
  const existing = getBySession(sessionId);
  if (!existing) return false;
  await existing.stop();
  unregister(existing.id);
  clearDesignSessionAllows(sessionId);
  return true;
}

export async function stopAllDesign(): Promise<void> {
  await stopAll();
}
