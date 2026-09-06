import { spawn as spawnProcess } from "node:child_process";
import { clearDesignSessionAllows } from "@/design/capabilities/llm-stream.ts";
import { startDesignRelay } from "@/design/relay/relay.ts";
import { getBySession, register, stopAll, unregister } from "@/design/spawn-registry.ts";
import { hasDesignSnapshotFile, isValidDesignId, listDesigns } from "@/design/storage.ts";
import type { DesignSpawnHandle } from "@/design/types.ts";
import type { Agent } from "@/engine/queue/index.ts";
import { appendRecord, type Session, type SessionRecord } from "@/engine/session/index.ts";
import { uuidv4 } from "@/kernel/std/id.ts";
import { installProcessSignalHandlers } from "@/kernel/std/process-shutdown.ts";
import type { Broker } from "@/store/app-store/broker.ts";

export interface StartDesignArgs {
  broker: Broker;
  session: Session;
  agent: Agent;
  cwd: string;
  version: string;
  designId?: string | undefined;
  initialPrompt?: string | undefined;
}

const DESIGN_SESSION_ATTACHMENT = "design_session";

export function resumableDesignId(records: readonly SessionRecord[], cwd: string): string | null {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (record?.type !== "attachment") continue;
    const attachment = record.attachment;
    if (attachment.type !== DESIGN_SESSION_ATTACHMENT) continue;
    if (attachment.active !== true || !isValidDesignId(attachment.designId)) return null;
    return hasDesignSnapshotFile(cwd, attachment.designId) ? attachment.designId : null;
  }
  return null;
}

function recordDesignSession(session: Session, designId: string, active: boolean): Promise<void> {
  return appendRecord(session, {
    type: "attachment",
    ts: new Date().toISOString(),
    attachment: {
      type: DESIGN_SESSION_ATTACHMENT,
      designId,
      active,
    },
  });
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
  installProcessSignalHandlers(stopAllDesign);
  const existing = getBySession(args.session.id);
  if (existing) await existing.stop();
  clearDesignSessionAllows(args.session.id);
  const spawnId = uuidv4();
  const localDesigns = listDesigns(args.cwd);
  const designId =
    args.designId ?? (localDesigns.length > 0 ? (localDesigns[0]?.designId ?? uuidv4()) : uuidv4());
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
  try {
    await recordDesignSession(args.session, designId, true);
  } catch (error) {
    await relay.stop();
    throw error;
  }
  const wrappedStop = async (): Promise<void> => {
    await relay.stop();
    unregister(spawnId);
  };
  const spawn = { ...relay.spawn, stop: wrappedStop };
  register(spawn);
  openBrowser(relay.url);
  return {
    spawnId,
    sessionHash: relay.sessionHash,
    designId,
    url: relay.url,
    stop: wrappedStop,
  };
}

export async function resumeDesign(
  args: Omit<StartDesignArgs, "designId" | "initialPrompt">,
): Promise<DesignSpawnHandle | null> {
  const designId = resumableDesignId(args.session.records, args.cwd);
  if (!designId) return null;
  return startDesign({ ...args, designId });
}

export async function stopDesign(sessionId: string): Promise<boolean> {
  const existing = getBySession(sessionId);
  if (!existing) return false;
  await recordDesignSession(existing.session, existing.designId, false);
  await existing.stop();
  unregister(existing.id);
  clearDesignSessionAllows(sessionId);
  return true;
}

export async function stopAllDesign(): Promise<void> {
  await stopAll();
}
