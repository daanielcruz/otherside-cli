import {
  authorizationHeader,
  currentTokens,
  resolveProjectId,
} from "@/engine/providers/antigravity/auth.ts";
import {
  buildCloudCodeEnvelope,
  buildInferenceHeaders,
  buildRequestId,
  streamGenerateContentUrl,
} from "@/engine/providers/antigravity/fingerprint.ts";
import { resolveAntigravityModel } from "@/engine/providers/antigravity/models.ts";
import { turnIds } from "@/engine/providers/antigravity/turn.ts";
import { collectText, sendChunkedRequest } from "@/engine/transport/http1-socket.ts";
import { parseSse } from "@/kernel/std/stream/sse.ts";
import { truncateEllipsis } from "@/kernel/std/text/text.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";
import {
  dedupeByUrl,
  filterResults,
  type WebSearchHit,
  type WebSearchInput,
  type WebSearchPayload,
} from "./common.ts";

const SEARCH_MODEL_ID = "gemini-3-flash";
const SEARCH_THINKING_BUDGET = 1001;
const MAX_RESULTS = 8;
const SEARCH_SYSTEM_PROMPT =
  "You are a search grounding tool used by an AI coding assistant. Your only job is to execute the user's search query via Google Search grounding and return factual search results with source URLs. If Google Search grounding returns no results, say so. Do not invent results.";

interface GroundedSearch {
  text: string;
  sources: WebSearchHit[];
}

function buildSearchEnvelope(query: string, project: string): Record<string, unknown> {
  const ids = turnIds(`websearch-${query}`);
  return buildCloudCodeEnvelope({
    model: resolveAntigravityModel(SEARCH_MODEL_ID).wireModel,
    project,
    requestId: buildRequestId({
      conversationId: ids.conversationId,
      trajectoryId: ids.trajectoryId,
      turn: 1,
    }),
    request: {
      contents: [{ role: "user", parts: [{ text: query }] }],
      systemInstruction: { parts: [{ text: SEARCH_SYSTEM_PROMPT }] },
      tools: [{ googleSearch: {} }],
      generationConfig: {
        temperature: 0,
        thinkingConfig: { includeThoughts: true, thinkingBudget: SEARCH_THINKING_BUDGET },
      },
    },
  });
}

export async function searchAntigravity(
  input: WebSearchInput,
  ctx: RequestContext,
): Promise<WebSearchPayload> {
  const started = Date.now();
  const tokens = await currentTokens();
  const project = await resolveProjectId(tokens);
  const bearer = await authorizationHeader();

  const envelope = buildSearchEnvelope(input.query, project);
  const res = await sendChunkedRequest({
    url: new URL(streamGenerateContentUrl()),
    headerLines: Object.entries(buildInferenceHeaders({ bearer })).map(
      ([name, value]) => `${name}: ${value}`,
    ),
    payload: Buffer.from(JSON.stringify(envelope), "utf8"),
  });

  const grounded = await readGrounded(res.status, res.body);
  const filtered = filterResults(
    grounded.sources,
    input.allowedDomains,
    input.blockedDomains,
  ).slice(0, MAX_RESULTS);
  const results: WebSearchPayload["results"] = [];
  if (grounded.text.trim().length > 0) results.push(grounded.text.trim());
  results.push(...filtered);
  if (results.length === 0) {
    results.push(`No Antigravity grounded search results found for query: ${input.query}`);
  }

  return {
    query: input.query,
    provider: ctx.provider,
    results,
    durationSeconds: (Date.now() - started) / 1000,
  };
}

async function readGrounded(
  status: number,
  body: AsyncIterable<Uint8Array>,
): Promise<GroundedSearch> {
  if (status < 200 || status >= 300) {
    const text = await collectText(body).catch(() => "");
    throw new Error(
      `antigravity web_search returned HTTP ${status}: ${truncateEllipsis(text, 500)}`,
    );
  }
  let text = "";
  const sources: WebSearchHit[] = [];

  for await (const ev of parseSse(body)) {
    if (!ev.data || ev.data === "[DONE]") continue;
    let chunk: Record<string, unknown>;
    try {
      chunk = JSON.parse(ev.data) as Record<string, unknown>;
    } catch {
      continue;
    }
    const response = (chunk.response ?? chunk) as Record<string, unknown>;
    const candidates = Array.isArray(response.candidates) ? response.candidates : [];
    for (const candidate of candidates) {
      if (!candidate || typeof candidate !== "object") continue;
      const c = candidate as Record<string, unknown>;
      const content = c.content as Record<string, unknown> | undefined;
      const parts = Array.isArray(content?.parts) ? content.parts : [];
      for (const part of parts) {
        if (!part || typeof part !== "object") continue;
        const p = part as Record<string, unknown>;
        if (p.thought === true) continue;
        if (typeof p.text === "string") text += p.text;
      }
      const grounding = c.groundingMetadata as Record<string, unknown> | undefined;
      const chunks = Array.isArray(grounding?.groundingChunks) ? grounding.groundingChunks : [];
      for (const item of chunks) {
        if (!item || typeof item !== "object") continue;
        const web = (item as Record<string, unknown>).web as Record<string, unknown> | undefined;
        const url = typeof web?.uri === "string" ? web.uri : "";
        if (!url) continue;
        sources.push({
          title: typeof web?.title === "string" && web.title ? web.title : url,
          url,
        });
      }
    }
  }

  return { text, sources: dedupeByUrl(sources) };
}
