import type { RequestContext } from "@/kernel/std/types/request.ts";

export interface CodexEnvelopeDeps {
  ctx: RequestContext;
  instructions: string | null;
  input: unknown;
  tools: unknown;
  promptCacheKey: string;
  effort: string | null;
  serviceTier?: string | undefined;
  useResponsesLite?: boolean | undefined;
  serviceTiers?: string[] | undefined;
  defaultVerbosity?: "low" | "medium" | "high" | undefined;
}

export function buildCodexEnvelope(deps: CodexEnvelopeDeps): Record<string, unknown> {
  const {
    ctx,
    instructions,
    input,
    tools,
    promptCacheKey,
    effort,
    serviceTier,
    useResponsesLite = false,
    serviceTiers = [],
    defaultVerbosity = "low",
  } = deps;
  const body: Record<string, unknown> = {
    model: ctx.model,
  };
  if (useResponsesLite) {
    body.parallel_tool_calls = false;
  } else {
    if (instructions) body.instructions = instructions;
    body.tools = tools;
    body.tool_choice = "auto";
    body.parallel_tool_calls = true;
  }
  body.input = input;
  body.reasoning = null;
  body.store = false;
  body.stream = true;
  body.include = [];
  body.text = { verbosity: defaultVerbosity };
  body.prompt_cache_key = promptCacheKey;

  if (effort) {
    if (ctx.disableThinking === true) {
      // Full off (internal one-shots): drop the entire transcript — summary text
      // AND the re-sendable encrypted_content. Effort itself is unaffected.
      body.reasoning = { effort };
    } else if (ctx.suppressThinkingSummary === true) {
      // Sub-agent/fork: keep reasoning effort AND continuity (encrypted_content),
      // drop only the displayed summary so it is neither relayed to the parent nor
      // re-sent as an accumulating transcript.
      body.reasoning = { effort };
      body.include = ["reasoning.encrypted_content"];
    } else {
      body.reasoning = { effort, summary: "auto" };
      body.include = ["reasoning.encrypted_content"];
    }
  }

  if (useResponsesLite) {
    body.reasoning = {
      ...(body.reasoning as Record<string, unknown> | null),
      context: "all_turns",
    };
  }

  if (serviceTier && serviceTiers.includes(serviceTier)) {
    body.service_tier = serviceTier;
  }
  if (ctx.provider === "codex" && ctx.fastMode && serviceTiers.includes("priority")) {
    body.service_tier = "priority";
  }

  return body;
}
