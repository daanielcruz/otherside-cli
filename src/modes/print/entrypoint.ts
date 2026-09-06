import { hasLoadedCredential } from "@/boot/startup-broker.ts";
import { OTHERSIDE_VERSION } from "@/boot/version.ts";
import { devtoolBoolean } from "@/devtools/settings.ts";
import { pricingFor } from "@/engine/contract/pricing.ts";
import { findModel } from "@/engine/model/catalog.ts";
import type { Agent } from "@/engine/queue/index.ts";
import { drainPendingAsyncRewakeHooks } from "@/engine/queue/runtime/stop-hook-rewake.ts";
import type { Session } from "@/engine/session/index.ts";
import * as tools from "@/engine/tools/registry.ts";
import { resolveConfig } from "@/kernel/config/resolver.ts";
import { fireConfiguredHooks } from "@/kernel/hooks/handler.ts";
import type { ProviderId } from "@/kernel/std/types/provider-ids.ts";
import { loadFor as loadCredentialsFor, type ProviderSlug } from "@/kernel/storage/credentials.ts";
import type { CliMode } from "@/modes/args.ts";
import { runPrintMode } from "@/modes/print/index.ts";
import type { Broker } from "@/store/app-store/broker.ts";

export async function runPrintEntrypoint(args: {
  mode: Extract<CliMode, { kind: "print" }>;
  agent: Agent;
  session: Session;
  broker: Broker;
  initialProvider: string;
  initialModel: string;
  customCreds: Awaited<ReturnType<typeof loadCredentialsFor>>;
}): Promise<void> {
  const { mode, agent, session, broker, initialProvider, initialModel, customCreds } = args;
  const traceOn = mode.verbose || devtoolBoolean("trace");
  const trace = (msg: string): void => {
    if (traceOn) process.stderr.write(`[print-trace] ${msg}\n`);
  };
  trace("checking credentials");
  const activeProvider = initialProvider as ProviderSlug;
  const activeCreds =
    activeProvider === "openai" ? customCreds : await loadCredentialsFor(activeProvider);
  if (!hasLoadedCredential(activeProvider, activeCreds)) {
    process.stderr.write(
      `otherside: no credentials for provider ${initialProvider}; launch \`otherside\` and sign in via /login first\n`,
    );
    process.exit(2);
  }
  trace(`credentials ok, provider=${initialProvider} model=${initialModel}`);
  // SIGINT in headless mode aborts the in-flight turn and exits cleanly (0),
  // rather than the default ~130 — a Ctrl-C in a script is not a failure.
  process.once("SIGINT", () => {
    agent.cancel();
    process.exit(0);
  });
  trace("running print mode");
  const agentRegistry = await import("@/engine/agents/registry.ts");
  const skillRegistry = await import("@/engine/skills/registry.ts");
  const { CATALOG: SLASH_CATALOG } = await import("@/commands/catalog.ts");
  const { loadMcpConfigChain, mergeChildWins } = await import("@/kernel/mcp/config.ts");
  const mcpChain = await loadMcpConfigChain(process.cwd()).catch(() => []);
  const mergedMcp = mergeChildWins(mcpChain);
  const mcpServers = Object.keys(mergedMcp.config.mcpServers ?? {});
  const exitCode = await runPrintMode(
    agent,
    mode.prompt,
    mode.outputFormat,
    {
      sessionId: session.id,
      // Session cwd, not process.cwd(): a launch-time worktree relocates the
      // session's working directory without chdir.
      cwd: session.cwd,
      route: { provider: initialProvider as ProviderId, model: initialModel },
      ...(mode.fallbackRoute ? { fallbackRoute: mode.fallbackRoute } : {}),
      permissionMode: broker.read().permissionMode,
      verbose: mode.verbose,
      contextWindow:
        findModel({ provider: initialProvider as ProviderId, model: initialModel })
          ?.contextWindow ?? 0,
      pricing: pricingFor(initialProvider as ProviderId, initialModel),
      maxTurns: mode.maxTurns,
      toolNames: tools.list().map((t) => t.schema.name),
      slashCommands: SLASH_CATALOG.map((s) => s.name),
      agentNames: agentRegistry.list().map((a) => a.name),
      skillNames: skillRegistry.list().map((s) => s.name),
      mcpServers,
      version: OTHERSIDE_VERSION,
    },
    trace,
  );
  trace(`print mode done exit=${exitCode}`);
  await drainPendingAsyncRewakeHooks();
  await fireConfiguredHooks(resolveConfig(session.storageCwd), "sessionEnd", {
    kind: "sessionEnd",
    ctx: { sessionId: session.id, cwd: session.cwd, reason: "other" },
  });
  process.exit(exitCode);
}
