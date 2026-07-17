import { currentConfig } from "@/engine/providers/openai/auth.ts";
import {
  authHeader,
  endpointFor,
  fingerprint,
  modelsUrl,
  modelUrlCandidates,
} from "@/engine/providers/openai/fingerprint.ts";
import { truncateEllipsis } from "@/kernel/std/text/text.ts";
import { isRecord } from "@/kernel/std/value-guards.ts";

export async function fetchModels(): Promise<string[]> {
  const cfg = await currentConfig();
  return (await fetchModelsForConfig(cfg.baseUrl, cfg.apiKey)).models.map((model) => model.id);
}

export interface OpenAiCustomModelInfo {
  id: string;
  displayName?: string;
  contextWindow?: number;
}

export interface OpenAiCustomModelsResult {
  models: OpenAiCustomModelInfo[];
  url: string;
  ok: boolean;
  error?: string;
}

export interface OpenAiCustomTestResult {
  ok: boolean;
  error?: string;
}

export async function fetchModelsForConfig(
  baseUrl: string,
  apiKey: string | null,
): Promise<OpenAiCustomModelsResult> {
  const urls = modelUrlCandidates(baseUrl);
  const fp = fingerprint({
    provider: "openai",
    model: "",
    effort: null,
    permissionMode: "default",
    sessionId: "",
    cwd: "/tmp",
  });
  const headers: Record<string, string> = {
    "User-Agent": fp.userAgent,
    Accept: "application/json",
    ...authHeader(apiKey),
  };
  const errors: string[] = [];
  let firstUrl = urls[0] ?? modelsUrl(baseUrl);
  for (const url of urls) {
    firstUrl = url;
    const result = await fetchModelsFromUrl(url, headers);
    if (result.ok || result.models.length > 0) return result;
    if (result.error) errors.push(`${url}: ${result.error}`);
  }
  return {
    ok: false,
    models: [],
    url: firstUrl,
    error: errors.length > 0 ? errors.join("; ") : "request failed",
  };
}

async function fetchModelsFromUrl(
  url: string,
  headers: Record<string, string>,
): Promise<OpenAiCustomModelsResult> {
  try {
    const resp = await fetch(url, { headers });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      return {
        ok: false,
        models: [],
        url,
        error: `HTTP ${resp.status}${text.length > 0 ? `: ${truncateEllipsis(text, 240)}` : ""}`,
      };
    }
    const data = await resp.json();
    const models = parseModelList(data);
    return {
      ok: models.length > 0,
      models,
      url,
      ...(models.length === 0 ? { error: "no models returned" } : {}),
    };
  } catch {
    return { ok: false, models: [], url, error: "request failed" };
  }
}

function parseModelList(data: unknown): OpenAiCustomModelInfo[] {
  const obj = isRecord(data) ? data : {};
  const raw = Array.isArray(obj.data) ? obj.data : Array.isArray(obj.models) ? obj.models : [];
  return raw.flatMap((item) => {
    if (!isRecord(item)) return [];
    if (item.type === "embedding") return [];
    const idValue = item.id ?? item.key ?? item.model ?? item.name;
    if (typeof idValue !== "string" || idValue.length === 0) return [];
    const displayValue = item.display_name ?? item.displayName;
    return [
      {
        id: idValue,
        ...(typeof displayValue === "string" && displayValue.length > 0
          ? { displayName: displayValue }
          : {}),
        ...contextFromModelItem(item),
      },
    ];
  });
}

function contextFromModelItem(item: Record<string, unknown>): { contextWindow?: number } {
  const candidates = [
    nestedNumber(item.loaded_instances, "config", "context_length"),
    item.max_context_length,
    item.maxContextLength,
    item.max_model_len,
    item.maxModelLen,
    item.context_length,
    item.contextLength,
    item.n_ctx,
    item.context_window,
    item.contextWindow,
  ];
  const value = candidates.find((candidate) => normalizeContextWindow(candidate) !== null);
  const normalized = normalizeContextWindow(value);
  return normalized === null ? {} : { contextWindow: normalized };
}

function nestedNumber(value: unknown, objectKey: string, numberKey: string): unknown {
  if (!Array.isArray(value)) return undefined;
  for (const item of value) {
    if (!isRecord(item)) continue;
    const nested = item[objectKey];
    if (isRecord(nested) && nested[numberKey] !== undefined) return nested[numberKey];
  }
  return undefined;
}

function normalizeContextWindow(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n);
}

export async function testConfig(
  baseUrl: string,
  apiKey: string | null,
  model: string,
  outputTokenLimit?: number,
): Promise<OpenAiCustomTestResult> {
  const fp = fingerprint({
    provider: "openai",
    model,
    effort: null,
    permissionMode: "default",
    sessionId: "",
    cwd: "/tmp",
  });
  const target = endpointFor(baseUrl);
  const headers: Record<string, string> = {
    "User-Agent": fp.userAgent,
    ...fp.extraHeaders,
    Accept: "application/json",
    ...authHeader(apiKey),
  };
  const body =
    target.kind === "simple_chat"
      ? {
          model,
          system_prompt: "You are a test client. Reply with ok.",
          input: "ok",
        }
      : {
          model,
          messages: [{ role: "user", content: "Reply with ok." }],
          max_tokens: outputTokenLimit ?? 64,
          stream: false,
        };
  try {
    const resp = await fetch(target.url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    if (resp.ok) return { ok: true };
    const text = await resp.text().catch(() => "");
    return {
      ok: false,
      error: `HTTP ${resp.status}${text.length > 0 ? `: ${truncateEllipsis(text, 240)}` : ""}`,
    };
  } catch {
    return { ok: false, error: "request failed" };
  }
}
