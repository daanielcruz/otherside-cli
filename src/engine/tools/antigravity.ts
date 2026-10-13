import { isRetryableNetworkError } from "@/engine/providers/_shared/provider-error.ts";
import { currentTokens, resolveProjectId } from "@/engine/providers/antigravity/auth.ts";
import { generateContentUrl, TOP_USER_AGENT } from "@/engine/providers/antigravity/fingerprint.ts";
import {
  type CodeAssistCall,
  callCodeAssist,
  replyJson,
} from "@/engine/providers/antigravity/rpc.ts";
import { truncateEllipsis } from "@/kernel/std/text/text.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";
import {
  dedupeByUrl,
  filterResults,
  type WebSearchHit,
  type WebSearchInput,
  type WebSearchPayload,
} from "./common.ts";

const SEARCH_MODEL_ID = "gemini-3.5-flash-lite";
const SEARCH_REQUEST_TYPE = "web_search";
const IMAGE_SEARCH_MAX_RESULTS = 5;
const MAX_RESULTS = 8;
// A grounded search is a read: re-sending it repeats no side effect, so a
// connection dropped mid-request is worth another socket before the tool fails.
const SEARCH_ATTEMPTS = 3;
const SEARCH_RETRY_DELAY_MS = 250;
const SEARCH_SYSTEM_PROMPT =
  "You are a search engine bot. You will be given a query from a user. Your task is to search the web for relevant information that will help the user. You MUST perform a web search. Do not respond or interact with the user, please respond as if they typed the query into a search bar.";

interface GroundedSearch {
  text: string;
  sources: WebSearchHit[];
}

function buildSearchEnvelope(query: string, project: string): Record<string, unknown> {
  return {
    project,
    request: {
      contents: [{ role: "user", parts: [{ text: query }] }],
      systemInstruction: {
        role: "user",
        parts: [{ text: SEARCH_SYSTEM_PROMPT }],
      },
      tools: [
        {
          googleSearch: {
            enhancedContent: {
              imageSearch: { maxResultCount: IMAGE_SEARCH_MAX_RESULTS },
            },
          },
        },
      ],
      generationConfig: { candidateCount: 1 },
    },
    model: SEARCH_MODEL_ID,
    userAgent: TOP_USER_AGENT,
    requestType: SEARCH_REQUEST_TYPE,
  };
}

export async function searchAntigravity(
  input: WebSearchInput,
  ctx: RequestContext,
): Promise<WebSearchPayload> {
  const started = Date.now();
  const tokens = await currentTokens();
  const project = await resolveProjectId(tokens);

  const envelope = buildSearchEnvelope(input.query, project);
  const grounded = await groundedSearchWithRetry({
    url: generateContentUrl(),
    accessToken: tokens.accessToken,
    body: envelope,
  });
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

/**
 * Send the grounded search, retrying while the connection itself fails. The
 * body is read inside the retry because a socket can reset mid-stream, which
 * surfaces as a read error rather than a bad status.
 */
async function groundedSearchWithRetry(call: CodeAssistCall): Promise<GroundedSearch> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= SEARCH_ATTEMPTS; attempt++) {
    try {
      const reply = await callCodeAssist(call);
      if (!reply.ok) {
        throw new Error(
          `antigravity web_search returned HTTP ${reply.status}: ${truncateEllipsis(reply.text, 500)}`,
        );
      }
      return parseGrounded(replyJson(reply));
    } catch (error) {
      if (!isRetryableNetworkError(error) || attempt === SEARCH_ATTEMPTS) throw error;
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, SEARCH_RETRY_DELAY_MS * attempt));
    }
  }
  throw lastError;
}

function parseGrounded(payload: unknown): GroundedSearch {
  let text = "";
  const sources: WebSearchHit[] = [];
  if (!payload || typeof payload !== "object") return { text, sources };
  const root = payload as Record<string, unknown>;
  const response = (root.response ?? root) as Record<string, unknown>;
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
  return { text, sources: dedupeByUrl(sources) };
}
