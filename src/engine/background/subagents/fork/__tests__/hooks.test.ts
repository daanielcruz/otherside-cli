import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runForkLoopExternal } from "@/engine/background/subagents/dispatcher.ts";
import type { Provider } from "@/engine/contract/types.ts";
import * as providers from "@/engine/providers/registry.ts";
import type { ProviderEvent } from "@/kernel/std/types/events.ts";
import type { Message } from "@/kernel/std/types/message.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";

const providerId = "subagent-start-hook-test" as RequestContext["provider"];
const model = "subagent-start-hook-model";

function makeCtx(cwd: string): RequestContext {
  return {
    provider: providerId,
    model,
    effort: null,
    permissionMode: "default",
    sessionId: `subagent-start-${crypto.randomUUID()}`,
    cwd,
  };
}

function registerProvider(events: ProviderEvent[]): void {
  const provider = {
    id: providerId,
    deferredOverrides: () => ({
      excludeFromCatalog: [],
      alwaysDeclare: [],
      emitDeferredReminder: false,
    }),
    translateRequest: (_ctx: RequestContext, _messages: Message[], _tools: unknown[]) => ({}),
    stream: async function* () {},
    translateResponse: async function* () {
      for (const event of events) yield event;
    },
    recoverableError: () => ({ kind: "fail", reason: "test" }),
  } as unknown as Provider;
  providers.register(provider);
}

describe("subagent start hooks", () => {
  test("fires with session, fork id, and agent type when the fork starts", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "otherside-subagent-start-hook-"));
    const outputPath = join(cwd, "hook.txt");
    const code =
      "require('node:fs').writeFileSync(process.argv[1], [process.env.SESSION_ID, process.env.SUBAGENT_ID, process.env.AGENT_TYPE].join('|'))";
    const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(code)} ${JSON.stringify(outputPath)}`;
    registerProvider([
      {
        kind: "text_delta",
        text: "The subagent start hook fired and the fork completed with a useful response.",
      },
      { kind: "message_stop", stop_reason: "stop" },
    ]);

    const ctx = makeCtx(cwd);
    const result = await runForkLoopExternal({
      ctx,
      name: "Hook Test Agent",
      body: "Finish normally.",
      allowSet: null,
      prompt: "Finish normally.",
      agentId: "hook-test-agent",
      agentHooks: {
        subagentStart: [{ matcher: "*", command, timeoutMs: 2_000 }],
      },
    });

    expect(result.isError).toBe(false);
    expect(existsSync(outputPath)).toBe(true);
    const [sessionId, subagentId, agentType] = readFileSync(outputPath, "utf8").split("|");
    expect(sessionId).toBe(ctx.sessionId);
    expect(subagentId).toMatch(/^fork_/);
    expect(agentType).toBe("hook-test-agent");
    rmSync(cwd, { recursive: true, force: true });
  });
});
