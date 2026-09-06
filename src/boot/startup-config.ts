import { isRemoteEnabled, sweepLegacyRemoteSessionState } from "@/backend/index.ts";
import { loadCorpus } from "@/engine/corpus.ts";
import { registerRuntimeModel } from "@/engine/model/catalog.ts";
import { seedExtraUsageDisabledReason } from "@/engine/providers/anthropic/access.ts";
import {
  listSessionFileRefs,
  migrateLegacySessions,
  registerSessionMetaRemoteEnabled,
} from "@/engine/session/index.ts";
import { scheduleRetentionCleanup } from "@/engine/session/retention.ts";
import type { UserConfig } from "@/kernel/config/config.ts";
import { resolveConfig } from "@/kernel/config/resolver.ts";
import {
  loadAll as loadAllCredentials,
  loadFor as loadCredentialsFor,
} from "@/kernel/storage/credentials.ts";
import { reloadBindings } from "@/ui/keys/binding-file.ts";
import { applyThemeSetting } from "@/ui/theme/custom/apply.ts";
import { setSyntaxHighlightingEnabled } from "@/ui/theme/syntax-highlighting.ts";

export async function loadStartupConfig(
  cwd: string,
  sessionOverride?: Partial<Pick<UserConfig, "showThinkingSummaries">>,
) {
  const cfg = resolveConfig(cwd, sessionOverride);
  applyThemeSetting(cfg.theme ?? "auto");
  setSyntaxHighlightingEnabled(cfg.syntaxHighlightingDisabled !== true);
  // Read once at boot and held: every key press consults the table, so a read on
  // that path would be disk I/O per keystroke.
  reloadBindings();
  const allCreds = await loadAllCredentials();
  const customCreds = await loadCredentialsFor("openai");
  if (customCreds?.contextWindow && (customCreds.model || cfg.defaultModel)) {
    const model = customCreds.model || cfg.defaultModel;
    registerRuntimeModel({
      id: model,
      displayName: model,
      contextWindow: customCreds.contextWindow,
      provider: "openai",
      efforts: [],
      defaultEffort: null,
    });
  }
  const { agentFailures } = loadCorpus({ config: cfg, cwd });
  seedExtraUsageDisabledReason(cfg.cachedExtraUsageDisabledReason);
  migrateLegacySessions();
  scheduleRetentionCleanup();
  registerSessionMetaRemoteEnabled(isRemoteEnabled);
  scheduleLegacyRemoteStateSweep();
  return { cfg, allCreds, customCreds, agentFailures };
}

const LEGACY_REMOTE_SWEEP_DELAY_MS = 5_000;
let legacyRemoteSweepScheduled = false;

function scheduleLegacyRemoteStateSweep(): void {
  if (legacyRemoteSweepScheduled) return;
  legacyRemoteSweepScheduled = true;
  setTimeout(() => {
    try {
      sweepLegacyRemoteSessionState(new Set(listSessionFileRefs().map((ref) => ref.id)));
    } catch {}
  }, LEGACY_REMOTE_SWEEP_DELAY_MS).unref();
}
