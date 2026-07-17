import { auxiliaryModelFor } from "@/engine/model/tier/tiers.ts";
import type { ToolHandler } from "@/engine/tools/contract.ts";
import { WebFetchSchema } from "@/engine/tools/dynamic/WebFetch.ts";
import { queryModel } from "@/engine/transport/_infra/classify/oneshot.ts";
import { isAbortError } from "@/kernel/std/stream/abort.ts";
import type { ToolCall, ToolResult } from "@/kernel/std/types/message.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";

const MAX_BODY_BYTES = 1_000_000;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 5;
const MAX_MARKDOWN_LENGTH = 100_000;

const WEB_FETCH_GATE_SYSTEM_PROMPT = `You are extracting information from a fetched web page for a coding agent. Answer the user's question based ONLY on the page content provided.

 - Enforce a strict 125-character maximum for quotes from any source document. Open Source Software is ok as long as we respect the license.
 - Use quotation marks for exact language from articles; any language outside of the quotation should never be word-for-word the same.
 - You are not a lawyer and never comment on the legality of your own prompts and responses.
 - Never produce or reproduce exact song lyrics.

Be concise. Include relevant details, code examples, and documentation excerpts as needed to answer the question.`;

const REJECTED_CONTENT_TYPE_SUBSTRINGS = [
  "application/octet-stream",
  "application/pdf",
  "image/",
  "audio/",
  "video/",
  "application/zip",
  "application/x-tar",
  "application/x-gzip",
  "application/x-7z-compressed",
];

interface WebFetchInput {
  url?: unknown;
  prompt?: unknown;
}

function err(toolUseId: string, msg: string): ToolResult {
  return { tool_use_id: toolUseId, content: msg, is_error: true };
}

function isHtmlContentType(ct: string): boolean {
  const lower = ct.toLowerCase();
  return lower.includes("text/html") || lower.includes("application/xhtml");
}

function isRejectedContentType(ct: string): boolean {
  const lower = ct.toLowerCase();
  return REJECTED_CONTENT_TYPE_SUBSTRINGS.some((needle) => lower.includes(needle));
}

function htmlToMarkdown(html: string): string {
  let out = html;
  out = out.replace(/<script[\s\S]*?<\/script>/gi, "");
  out = out.replace(/<style[\s\S]*?<\/style>/gi, "");
  out = out.replace(/<noscript[\s\S]*?<\/noscript>/gi, "");
  out = out.replace(/<!--[\s\S]*?-->/g, "");
  out = out.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, level: string, inner: string) => {
    const n = Number.parseInt(level, 10);
    return `\n${"#".repeat(n)} ${stripTags(inner).trim()}\n\n`;
  });
  out = out.replace(
    /<a\s+[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
    (_m, href: string, inner: string) => {
      const text = stripTags(inner).trim();
      return text ? `[${text}](${href})` : href;
    },
  );
  out = out.replace(
    /<(strong|b)[^>]*>([\s\S]*?)<\/\1>/gi,
    (_m, _t, inner: string) => `**${stripTags(inner)}**`,
  );
  out = out.replace(
    /<(em|i)[^>]*>([\s\S]*?)<\/\1>/gi,
    (_m, _t, inner: string) => `*${stripTags(inner)}*`,
  );
  out = out.replace(
    /<code[^>]*>([\s\S]*?)<\/code>/gi,
    (_m, inner: string) => `\`${stripTags(inner)}\``,
  );
  out = out.replace(/<br\s*\/?>/gi, "\n");
  out = out.replace(/<\/p>/gi, "\n\n");
  out = out.replace(/<\/li>/gi, "\n");
  out = out.replace(/<li[^>]*>/gi, "- ");
  out = stripTags(out);
  out = decodeEntities(out);
  out = out
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return out;
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, "");
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_m, n: string) => String.fromCharCode(Number.parseInt(n, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, n: string) => String.fromCharCode(Number.parseInt(n, 16)));
}

export const WebFetch: ToolHandler = {
  schema: {
    name: WebFetchSchema.name,
    description: WebFetchSchema.description,
    inputSchema: WebFetchSchema.inputSchema,
  },
  isConcurrencySafe: true,
  async run(call: ToolCall, ctx: RequestContext): Promise<ToolResult> {
    const args = (call.input ?? {}) as WebFetchInput;
    const url = typeof args.url === "string" ? args.url : null;
    if (!url) return err(call.id, "url is required");

    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch (e) {
      return err(call.id, `invalid url \`${url}\`: ${(e as Error).message}`);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return err(
        call.id,
        `unsupported url scheme \`${parsed.protocol.replace(":", "")}\` (only http / https)`,
      );
    }

    const promptArg = typeof args.prompt === "string" ? args.prompt : "";

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
    try {
      let current = url;
      let resp: Response | null = null;
      let redirects = 0;
      while (true) {
        resp = await fetch(current, { signal: ctrl.signal, redirect: "manual" });
        if (resp.status >= 300 && resp.status < 400 && resp.headers.has("location")) {
          const next = new URL(resp.headers.get("location") ?? "", current).toString();
          const fromHost = new URL(current).host;
          const toHost = new URL(next).host;
          if (fromHost !== toHost) {
            const statusText =
              resp.status === 301
                ? "Moved Permanently"
                : resp.status === 308
                  ? "Permanent Redirect"
                  : resp.status === 307
                    ? "Temporary Redirect"
                    : "Found";
            const message = `REDIRECT DETECTED: The URL redirects to a different host.\n\nOriginal URL: ${current}\nRedirect URL: ${next}\nStatus: ${resp.status} ${statusText}\n\nTo complete your request, I need to fetch content from the redirected URL. Please use WebFetch again with these parameters:\n- url: "${next}"\n- prompt: "${promptArg}"`;
            return {
              tool_use_id: call.id,
              content: JSON.stringify({
                url: current,
                redirect_url: next,
                status: resp.status,
                code_text: statusText,
                cross_host_redirect: true,
                content: message,
              }),
            };
          }
          redirects++;
          if (redirects > MAX_REDIRECTS)
            return err(call.id, `too many redirects (>${MAX_REDIRECTS})`);
          current = next;
          continue;
        }
        break;
      }
      if (!resp) return err(call.id, "fetch produced no response");

      const finalUrl = current;
      const contentType = resp.headers.get("content-type") ?? "application/octet-stream";

      if (!resp.ok) {
        const hint = httpErrorHint(resp.status);
        return {
          tool_use_id: call.id,
          content: JSON.stringify({
            url: finalUrl,
            status: resp.status,
            content_type: contentType,
            error: `HTTP ${resp.status}${hint ? ` — ${hint}` : ""}`,
            content: hint
              ? `Request to ${finalUrl} failed with HTTP ${resp.status}. ${hint}`
              : `Request to ${finalUrl} failed with HTTP ${resp.status}.`,
          }),
          is_error: true,
        };
      }
      if (isRejectedContentType(contentType)) {
        return err(
          call.id,
          `refused binary content type \`${contentType}\` for url \`${finalUrl}\``,
        );
      }

      const buf = await resp.arrayBuffer();
      const truncated = buf.byteLength > MAX_BODY_BYTES;
      const slice = truncated ? buf.slice(0, MAX_BODY_BYTES) : buf;
      const text = new TextDecoder("utf-8", { fatal: false }).decode(slice);
      const markdown = isHtmlContentType(contentType) ? htmlToMarkdown(text) : text;
      const started = Date.now();
      const gateInput =
        markdown.length > MAX_MARKDOWN_LENGTH
          ? `${markdown.slice(0, MAX_MARKDOWN_LENGTH)}\n\n[Content truncated due to length...]`
          : markdown;
      const question =
        promptArg.length > 0 ? promptArg : "Summarize the main content of this page concisely.";
      // Providers without a samurai/daimyo tier resolve to the "inherit" sentinel;
      // fall back to the active session model so the gate never sends that id.
      const auxModel = auxiliaryModelFor(ctx.provider);
      const gateModel = auxModel === "inherit" ? ctx.model : auxModel;
      const gate = await queryModel(ctx, {
        model: gateModel,
        systemPrompt: WEB_FETCH_GATE_SYSTEM_PROMPT,
        userPrompt: `Web page content:\n---\n${gateInput}\n---\n\n${question}`,
      });
      if ("error" in gate) {
        return err(call.id, `WebFetch gate failed: ${gate.error}`);
      }

      return {
        tool_use_id: call.id,
        content: JSON.stringify({
          url: finalUrl,
          status: resp.status,
          content_type: contentType,
          result: gate.text,
          durationMs: Date.now() - started,
          truncated,
        }),
      };
    } catch (e) {
      const msg = isAbortError(e)
        ? `fetch timed out after ${REQUEST_TIMEOUT_MS}ms`
        : `fetch failed: ${(e as Error).message}`;
      return err(call.id, msg);
    } finally {
      clearTimeout(timer);
    }
  },
};

function httpErrorHint(status: number): string {
  if (status === 401)
    return "401 Unauthorized — credentials missing or invalid. Check API key/token.";
  if (status === 403)
    return "403 Forbidden — request rejected. May need authentication or different headers.";
  if (status === 404) return "404 Not Found — the resource does not exist at this URL.";
  if (status === 429) return "429 Too Many Requests — rate-limited. Back off and retry later.";
  if (status >= 500 && status < 600)
    return `${status} Server Error — the remote server failed. Retry later.`;
  if (status >= 400 && status < 500) return `${status} Client Error.`;
  return "";
}
