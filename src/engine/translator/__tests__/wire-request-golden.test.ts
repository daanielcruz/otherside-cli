import { beforeEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import type { WireFingerprint } from "@/engine/contract/types.ts";
import {
  API_MESSAGES_URL as ANTHROPIC_URL,
  fingerprint as anthropicFingerprint,
} from "@/engine/providers/anthropic/_infra/fingerprint.ts";
import { _resetWireLatchesForTests } from "@/engine/providers/anthropic/_infra/wire-latches.ts";
import { applyCchAttestation } from "@/engine/providers/anthropic/cch.ts";
import { composeAnthropicMessages } from "@/engine/providers/anthropic/compose.ts";
import { translateRequestAnthropic } from "@/engine/providers/anthropic/translate.ts";
import {
  buildCloudCodeEnvelope,
  buildInferenceHeaders,
  DAILY_HOST,
  STREAM_GENERATE_CONTENT_PATH,
} from "@/engine/providers/antigravity/fingerprint.ts";
import { resolveAntigravityModel } from "@/engine/providers/antigravity/models.ts";
import { translateRequestAntigravity } from "@/engine/providers/antigravity/translate.ts";
import { registerAllProviders } from "@/engine/providers/bootstrap.ts";
import {
  API_MESSAGES_URL as DEEPSEEK_URL,
  authHeader as deepseekAuth,
  fingerprint as deepseekFingerprint,
} from "@/engine/providers/deepseek/fingerprint.ts";
import { translateRequestDeepseek } from "@/engine/providers/deepseek/translate.ts";
import {
  API_MESSAGES_URL as GLM_URL,
  authHeader as glmAuth,
  fingerprint as glmFingerprint,
} from "@/engine/providers/glm/fingerprint.ts";
import { translateRequestGlm } from "@/engine/providers/glm/translate.ts";
import {
  API_MESSAGES_URL as KIMI_URL,
  authHeader as kimiAuth,
  fingerprint as kimiFingerprint,
} from "@/engine/providers/kimi/fingerprint.ts";
import { translateRequestKimi } from "@/engine/providers/kimi/translate.ts";
import {
  API_MESSAGES_URL as MINIMAX_URL,
  authHeader as minimaxAuth,
  fingerprint as minimaxFingerprint,
} from "@/engine/providers/minimax/fingerprint.ts";
import { translateRequestMinimax } from "@/engine/providers/minimax/translate.ts";
import {
  authHeader as openaiAuth,
  endpointFor as openaiEndpointFor,
  fingerprint as openaiFingerprint,
} from "@/engine/providers/openai/fingerprint.ts";
import {
  type OpenAiTranslated,
  translateRequest as translateRequestOpenAi,
} from "@/engine/providers/openai/translate.ts";
import type { ComposedHarness } from "@/harness/composer/injections.ts";
import type { Message } from "@/kernel/std/types/message.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";

// Wire-safe baseline (ROADMAP NOW #0) — the FULL request gate.
//
// Locks the final wire request {url, headers, body} for the providers whose
// assembly is deterministic offline (no mitm, no SDK transport). Sibling to:
//   - wire-facts.snapshot.test.ts (model-derived facts only; gates #1 registry)
//   - harness-compose-snapshot.test.ts (harness BUILD; gates #2)
// This file gates the FINAL assembly = compose + translate + cch + fingerprint.
// Gate every #1/#2/#5 structural move on its byte-diff: a behaviour-preserving
// refactor leaves these snapshots untouched.
//
// Each snapshot carries `bodyHash` = sha256 of the EXACT serialized wire bytes.
// The parsed `body` is the diffable companion (Bun's serializer alphabetizes
// keys, so only the hash catches a key-order regression — load-bearing on the
// compat rows, which have no cch checksum of their own).
//
// DEFERRED (need ctx-injected determinism / SDK transport — documented gaps):
//   codex   — body carries __codex_turn_metadata with random turn/session/window ids.
//   antigravity — body is deterministic but ships through the Google SDK; add
//                   a body-only snapshot when prioritized. This is also where the
//                   per-fork `suppressThinkingSummary` summary-drop on codex/antigravity
//                   would be locked (anthropic/glm/deepseek/kimi couple it → no-op).

registerAllProviders();

// FROZEN FIXTURES — editing any of these rewrites the cch token and body bytes,
// churning every anthropic snapshot. The first user text feeds the billing
// attributionFingerprint (preamble indices [4,7,20]).
const MESSAGES: Message[] = [
  { role: "user", content: [{ type: "text", text: "explain the build" }] },
  {
    role: "assistant",
    content: [
      {
        type: "tool_use",
        id: "toolu_fixture",
        name: "Bash",
        input: { command: "make build-install" },
      },
    ],
  },
  {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: "toolu_fixture", content: "ok" }],
  },
  { role: "user", content: [{ type: "text", text: "now ship it" }] },
];

// anthropic builds its system from the harness; the compat providers extract it
// from a system message, so they get one prepended to exercise that path.
const COMPAT_MESSAGES: Message[] = [
  { role: "system", content: [{ type: "text", text: "FIXED-SYSTEM-PROMPT" }] },
  ...MESSAGES,
];

const TOOLS: unknown[] = [
  {
    name: "Bash",
    description: "Run a shell command.",
    input_schema: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    },
  },
  {
    name: "Read",
    description: "Read a file.",
    input_schema: {
      type: "object",
      properties: { file_path: { type: "string" } },
      required: ["file_path"],
    },
  },
];

const HARNESS_FLAGSHIP: ComposedHarness = {
  layers: [],
  combined: "",
  systemBlocks: [
    { text: "FIXED-STATIC-A", phase: "static" },
    { text: "FIXED-STATIC-B", phase: "static" },
    { text: "FIXED-DYNAMIC-ENV", phase: "dynamic" },
  ],
  userPrepend: [
    { text: "memory body line", bundleKey: "user-context" },
    { text: "- foo/\n- bar/", bundleKey: "directoryStructure" },
  ],
  midSystemBlocks: [{ text: "mid-conversation note", bundleKey: "context" }],
};

// Non-flagship reality: no mid-system splice (supportsMidSystem=false).
const HARNESS_PLAIN: ComposedHarness = {
  layers: [],
  combined: "",
  systemBlocks: HARNESS_FLAGSHIP.systemBlocks,
  userPrepend: HARNESS_FLAGSHIP.userPrepend,
};

function context(overrides: Partial<RequestContext>): RequestContext {
  return {
    provider: "anthropic",
    model: "claude-opus-4-8",
    effort: null,
    permissionMode: "default",
    sessionId: "sess-fixture-00000000-0000-0000-0000-000000000000",
    cwd: "/tmp/fixture",
    agentic: true,
    ...overrides,
  };
}

// Volatile-or-secret headers: redacted to "<key>" so the golden locks key
// presence + ordering without per-request / per-machine / secret values.
const REDACT = new Set([
  "authorization",
  "x-api-key",
  "x-client-request-id",
  "x-os-category",
  "x-os-version",
  "x-platform",
  "x-query-id",
  "x-request-id",
  "x-stainless-arch",
  "x-stainless-os",
  "x-zcode-trace-id",
]);

function wireHeaders(
  fp: WireFingerprint,
  auth: Record<string, string>,
  zcodeStyle = false,
): Record<string, string> {
  if (zcodeStyle) {
    return {
      "content-type": "application/json",
      "user-agent": fp.userAgent,
      ...fp.extraHeaders,
      ...auth,
    };
  }
  return {
    Accept: "application/json",
    "Content-Type": "application/json",
    "User-Agent": fp.userAgent,
    ...fp.extraHeaders,
    ...auth,
  };
}

function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of Object.keys(headers).sort()) {
    const value = headers[key];
    if (value === undefined) continue;
    out[key] = REDACT.has(key.toLowerCase()) ? `<${key.toLowerCase()}>` : value;
  }
  return out;
}

// Pinning metadata stabilizes the CCH and avoids machine/account identifiers in snapshots.
function pinMetadata(body: Record<string, unknown>, sessionId: string): void {
  body.metadata = {
    user_id: JSON.stringify({
      device_id: "0".repeat(64),
      account_uuid: "acct-fixture",
      session_id: sessionId,
    }),
  };
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

interface WireSnapshot {
  url: string;
  headers: Record<string, string>;
  bodyHash: string;
  body: unknown;
}

function fromWire(
  url: string,
  fp: WireFingerprint,
  auth: Record<string, string>,
  wire: string,
  zcodeStyle = false,
): WireSnapshot {
  return {
    url,
    headers: redactHeaders(wireHeaders(fp, auth, zcodeStyle)),
    bodyHash: sha256(wire),
    body: JSON.parse(wire),
  };
}

function anthropicSnapshot(ctx: RequestContext, harness: ComposedHarness): WireSnapshot {
  const composed = composeAnthropicMessages(harness, MESSAGES);
  const body = translateRequestAnthropic(ctx, composed, TOOLS) as Record<string, unknown>;
  pinMetadata(body, ctx.sessionId);
  const wire = applyCchAttestation(JSON.stringify(body));
  return fromWire(ANTHROPIC_URL, anthropicFingerprint(ctx), { Authorization: "<redacted>" }, wire);
}

type Translate = (ctx: RequestContext, messages: Message[], tools: unknown[]) => unknown;
type Fingerprint = (ctx: RequestContext) => WireFingerprint;
type AuthHeader = (apiKey: string) => Record<string, string>;

function compatSnapshot(spec: {
  translate: Translate;
  fp: Fingerprint;
  auth: AuthHeader;
  url: string;
  ctx: RequestContext;
  pin: boolean;
}): WireSnapshot {
  const body = spec.translate(spec.ctx, COMPAT_MESSAGES, TOOLS) as Record<string, unknown>;
  // deepseek reuses anthropic's translate → its metadata reads device-id + the
  // real account_uuid; pin it (the others use empty shared metadata).
  if (spec.pin) pinMetadata(body, spec.ctx.sessionId);
  const wire = JSON.stringify(body);
  return fromWire(
    spec.url,
    spec.fp(spec.ctx),
    spec.auth("<redacted>"),
    wire,
    spec.ctx.provider === "glm",
  );
}

beforeEach(() => {
  // fastMode is a sticky process-global latch; reset so an earlier test file in
  // the same bun run cannot leak FAST_MODE_BETA into this golden.
  _resetWireLatchesForTests();
});

const ANTHROPIC_MATRIX: ReadonlyArray<{
  label: string;
  ctx: RequestContext;
  harness: ComposedHarness;
}> = [
  {
    label: "opus / agentic / default-effort / flagship",
    ctx: context({}),
    harness: HARNESS_FLAGSHIP,
  },
  {
    label: "opus / agentic / high",
    ctx: context({ effort: "high" }),
    harness: HARNESS_FLAGSHIP,
  },
  {
    label: "opus[1m] / agentic",
    ctx: context({ model: "claude-opus-4-8[1m]" }),
    harness: HARNESS_FLAGSHIP,
  },
  {
    label: "sonnet / agentic / plain",
    ctx: context({ model: "claude-sonnet-5" }),
    harness: HARNESS_PLAIN,
  },
  {
    label: "haiku / agentic / plain",
    ctx: context({ model: "claude-haiku-4-5" }),
    harness: HARNESS_PLAIN,
  },
  {
    label: "haiku / subagent (agentic, sidechain → dated id)",
    ctx: context({
      model: "claude-haiku-4-5",
      parentThreadId: "sub-fixture-0000",
    }),
    harness: HARNESS_PLAIN,
  },
  {
    label: "haiku / title (non-agentic, structured)",
    ctx: context({
      model: "claude-haiku-4-5",
      agentic: false,
      cacheRole: "title",
    }),
    harness: HARNESS_PLAIN,
  },
  {
    label: "fable / agentic",
    ctx: context({ model: "claude-fable-5" }),
    harness: HARNESS_FLAGSHIP,
  },
  {
    label: "opus / agentic / disableThinking",
    ctx: context({ disableThinking: true }),
    harness: HARNESS_FLAGSHIP,
  },
];

describe("anthropic wire-request golden (gates #1/#2/#5 final assembly)", () => {
  for (const { label, ctx, harness } of ANTHROPIC_MATRIX) {
    it(label, () => {
      expect(anthropicSnapshot(ctx, harness)).toMatchSnapshot();
    });
  }
});

function openaiCustomSnapshot(): WireSnapshot {
  const ctx = context({ provider: "openai-custom", model: "fixture-model" });
  const translated = translateRequestOpenAi(ctx, COMPAT_MESSAGES, TOOLS) as OpenAiTranslated;
  const target = openaiEndpointFor("https://openai-custom.test/v1");
  const wire = JSON.stringify({
    ...translated.chat,
    stream_options: { include_usage: true },
  });
  return fromWire(target.url, openaiFingerprint(ctx), openaiAuth("fixture-api-key"), wire);
}

function antigravitySnapshot(ctx: RequestContext): WireSnapshot {
  const request = translateRequestAntigravity(ctx, COMPAT_MESSAGES, TOOLS) as Record<
    string,
    unknown
  >;
  const envelope = buildCloudCodeEnvelope({
    model: resolveAntigravityModel(ctx.model).wireModel,
    project: "project-fixture",
    requestId: "agent/conversation-fixture/1700000000000/trajectory-fixture/1",
    request,
  });
  const wire = JSON.stringify(envelope);
  const url = `${DAILY_HOST}${STREAM_GENERATE_CONTENT_PATH}?alt=sse`;
  const headers = buildInferenceHeaders({ bearer: "Bearer fixture-token" });
  const userAgent = headers["User-Agent"];
  if (userAgent) {
    headers["User-Agent"] = userAgent.replace(
      /os_type=[^;]+; arch=[^;]+/,
      "os_type=<os>; arch=<arch>",
    );
  }
  return {
    url,
    headers: redactHeaders(headers),
    bodyHash: sha256(wire),
    body: JSON.parse(wire),
  };
}

const COMPAT_MATRIX: ReadonlyArray<{
  label: string;
  spec: Parameters<typeof compatSnapshot>[0];
}> = [
  {
    label: "kimi / kimi-for-coding",
    spec: {
      translate: translateRequestKimi,
      fp: kimiFingerprint,
      auth: kimiAuth,
      url: KIMI_URL,
      ctx: context({ provider: "kimi-code", model: "kimi-for-coding" }),
      pin: false,
    },
  },
  {
    label: "glm / glm-5.2",
    spec: {
      translate: translateRequestGlm,
      fp: glmFingerprint,
      auth: glmAuth,
      url: GLM_URL,
      ctx: context({ provider: "glm", model: "glm-5.2", effort: "high" }),
      pin: false,
    },
  },
  {
    label: "minimax / minimax-m2.7",
    spec: {
      translate: translateRequestMinimax,
      fp: minimaxFingerprint,
      auth: minimaxAuth,
      url: MINIMAX_URL,
      ctx: context({ provider: "minimax", model: "minimax-m2.7" }),
      pin: false,
    },
  },
  {
    label: "deepseek / deepseek-v4-pro",
    spec: {
      translate: translateRequestDeepseek,
      fp: deepseekFingerprint,
      auth: deepseekAuth,
      url: DEEPSEEK_URL,
      ctx: context({
        provider: "deepseek",
        model: "deepseek-v4-pro",
        effort: "high",
      }),
      pin: true,
    },
  },
  {
    label: "deepseek / deepseek-v4-pro / disableThinking",
    spec: {
      translate: translateRequestDeepseek,
      fp: deepseekFingerprint,
      auth: deepseekAuth,
      url: DEEPSEEK_URL,
      ctx: context({
        provider: "deepseek",
        model: "deepseek-v4-pro",
        effort: "high",
        disableThinking: true,
      }),
      pin: true,
    },
  },
];

describe("anthropic-compat wire-request golden", () => {
  for (const { label, spec } of COMPAT_MATRIX) {
    it(label, () => {
      expect(compatSnapshot(spec)).toMatchSnapshot();
    });
  }
});

describe("OpenAI Custom wire-request golden", () => {
  it("uses a fixed non-default base URL without host configuration", () => {
    expect(openaiCustomSnapshot()).toMatchSnapshot();
  });
});

describe("Antigravity wire-request golden", () => {
  it("captures the Gemini-family Cloud Code envelope", () => {
    expect(
      antigravitySnapshot(context({ provider: "antigravity", model: "gemini-3-flash-medium" })),
    ).toMatchSnapshot();
  });

  it("suppresses thinking summaries for a fork", () => {
    expect(
      antigravitySnapshot(
        context({
          provider: "antigravity",
          model: "gemini-3-flash-medium",
          agentOwnerId: "fork-fixture",
          suppressThinkingSummary: true,
        }),
      ),
    ).toMatchSnapshot();
  });
});
