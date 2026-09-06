import { setTaskOutputSession } from "@/engine/background/tasks/output-files.ts";
import { Agent } from "@/engine/queue/index.ts";
import { restoreGoalFromRecords } from "@/engine/queue/state.ts";
import {
  type loadSessionForResume,
  Session,
  sessionMetaFromBrokerState,
} from "@/engine/session/index.ts";
import type { ToolOutputArchiveSessionRecord } from "@/engine/session/record/schema.ts";
import { sessionRecordsToMessages } from "@/engine/session/transcript/to-messages.ts";
import {
  createToolOutputArchive,
  restoreToolOutputArchive,
} from "@/engine/tool-output-archive/index.ts";
import { sanitizeMessages } from "@/engine/translator/index.ts";
import { initScratchpadDir } from "@/harness/routines/scratchpad.ts";
import type { loadConfig } from "@/kernel/config/config.ts";
import { uuidv4 } from "@/kernel/std/id.ts";
import { setTrackedCwd } from "@/kernel/std/state/cwd-state.ts";
import type { Broker } from "@/store/app-store/broker.ts";

export async function buildResumedSession(args: {
  effectiveResumeId: string | null;
  resumeRecords: Awaited<ReturnType<typeof loadSessionForResume>>["records"];
  /** Whether those records are a reduced view; a full rewrite must refuse on one. */
  resumeRecordsArePartial: boolean;
  resumeModelRecords?: Awaited<ReturnType<typeof loadSessionForResume>>["modelRecords"];
  resumeUsageRecords: Awaited<ReturnType<typeof loadSessionForResume>>["usageRecords"];
  chainHead: Awaited<ReturnType<typeof loadSessionForResume>>["chainHead"];
  resumeCwd?: Awaited<ReturnType<typeof loadSessionForResume>>["cwd"];
  resumePreservedImageLedger?: Awaited<
    ReturnType<typeof loadSessionForResume>
  >["preservedImageLedger"];
  isResume: boolean;
  broker: Broker;
  cfg: Awaited<ReturnType<typeof loadConfig>>;
  isPrint?: boolean;
}): Promise<{ session: Session; agent: Agent }> {
  const {
    effectiveResumeId,
    resumeRecords,
    resumeRecordsArePartial,
    resumeModelRecords = resumeRecords,
    resumeUsageRecords,
    chainHead,
    resumeCwd,
    resumePreservedImageLedger,
    isResume,
    broker,
    cfg,
    isPrint,
  } = args;
  const sessionCwd = isResume && resumeCwd ? resumeCwd : process.cwd();
  const session = new Session(effectiveResumeId ?? uuidv4(), sessionCwd);
  setTrackedCwd(session.cwd);
  initScratchpadDir(session.cwd, session.id);
  setTaskOutputSession({ sessionId: session.id, cwd: session.cwd });
  const { currentGitBranch } = await import("@/engine/session/paths.ts");
  const gitBranch = currentGitBranch(session.cwd);
  if (gitBranch) session.gitBranch = gitBranch;
  session.recordsArePartial = resumeRecordsArePartial;
  for (const record of resumeRecords) session.pushRecord(record);
  for (const record of resumeUsageRecords) session.pushUsageRecord(record);
  if (isResume && resumePreservedImageLedger) {
    session.preservedImageLedger = resumePreservedImageLedger;
  }
  if (isResume) restoreGoalFromRecords(session.id, resumeRecords);
  if (isResume && chainHead) {
    session.chain.seed(chainHead);
  }
  session.messages.push(...sanitizeMessages(sessionRecordsToMessages(resumeModelRecords)));
  if (isResume) {
    const archiveRecords = resumeRecords
      .filter(
        (record): record is ToolOutputArchiveSessionRecord => record.type === "content_replacement",
      )
      .map((record) => ({
        kind: record.kind,
        toolUseId: record.toolUseId,
        replacement: record.replacement,
      }));
    session.toolOutputArchive = restoreToolOutputArchive(session.messages, archiveRecords);
  } else {
    session.toolOutputArchive = createToolOutputArchive();
  }
  const { nowIso } = await import("@/engine/session/record/index.ts");
  if (!isResume) {
    session.pendingMeta = sessionMetaFromBrokerState(session, broker.read(), nowIso());
  }
  const { getLastUsage } = await import("@/engine/session/compact/last-usage.ts");
  const agent = new Agent({ broker, session, config: cfg, getLastUsage });
  if (isResume) {
    const { replayInjectionsFromRecords } = await import("@/engine/session/resume.ts");
    replayInjectionsFromRecords(resumeRecords, agent);
  }
  if (!isPrint) {
    const { probeQuotaStatus } = await import("@/engine/providers/anthropic/quota-probe.ts");
    void probeQuotaStatus(broker);
  }
  return { session, agent };
}
