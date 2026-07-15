import { getProviderConfig } from "@/engine/contract/registry.ts";
import type { ProviderId } from "@/kernel/config/provider-ids.ts";
import { getShortTimeZone } from "@/kernel/std/intl.ts";

export function formatResetTime(unixSeconds: number): string | null {
  if (!Number.isFinite(unixSeconds)) return null;
  const ms = unixSeconds * 1000;
  if (ms <= Date.now()) return null;
  const date = new Date(ms);
  const now = new Date();
  const minutes = date.getMinutes();
  const timeZone = getShortTimeZone(date);
  const hoursUntilReset = (ms - now.getTime()) / 3_600_000;
  if (hoursUntilReset > 24) return withTimezone(formatLongReset(date, now, minutes), timeZone);
  return withTimezone(
    date.toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: minutes === 0 ? undefined : "2-digit",
      hour12: true,
    }),
    timeZone,
  );
}

export function resetSuffixFromUnix(unixSeconds: number | undefined): string {
  if (unixSeconds === undefined) return "";
  const text = formatResetTime(unixSeconds);
  return text ? ` · resets ${text}` : "";
}

export function resetSuffixFromIso(resetsAt: string | null): string {
  if (!resetsAt) return "";
  const ms = Date.parse(resetsAt);
  if (!Number.isFinite(ms) || ms <= Date.now()) return "";
  return resetSuffixFromUnix(Math.floor(ms / 1000));
}

export function resetSuffixFromAny(value: number | string | null): string {
  if (typeof value === "number") return resetSuffixFromUnix(value);
  return resetSuffixFromIso(value);
}

export function usedMessage(
  label: string,
  utilization: number,
  resetsAt: number | string | null,
): string {
  return `You've used ${Math.floor(utilization)}% of your ${label}${resetSuffixFromAny(resetsAt)}`;
}

export function hitMessage(label: string, resetsAt: number | string | null): string {
  return `You've hit your ${label}${resetSuffixFromAny(resetsAt)}`;
}

export function approachingMessage(label: string, resetsAt: number | string | null): string {
  return `Approaching ${label}${resetSuffixFromAny(resetsAt)}`;
}

function formatLongReset(date: Date, now: Date, minutes: number): string {
  const dateText = date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: date.getFullYear() !== now.getFullYear() ? "numeric" : undefined,
  });
  const timeText = date.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: minutes === 0 ? undefined : "2-digit",
    hour12: true,
  });
  return `${dateText} at ${timeText}`;
}

function withTimezone(value: string, timeZone: string): string {
  return `${value.replace(/ ([AP]M)/i, (_match, ampm: string) => ampm.toLowerCase())} (${timeZone})`;
}

/** Percent text that preserves a meaningful decimal (99.9) instead of flooring/rounding to an integer. */
export function formatQuotaPercent(value: number): string {
  if (!Number.isFinite(value)) return "0";
  const clamped = Math.max(0, Math.min(100, value));
  return Number.isInteger(clamped) ? String(clamped) : clamped.toFixed(1).replace(/\.0$/, "");
}

/** Capitalize the first character of the window/family label so the warning reads `pct% Weekly` rather than `pct% weekly`. */
function capitalizeWindowLabel(value: string): string {
  if (value.length === 0) return value;
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/** Short reset text for the central quota-warning template; "unknown" for null/undefined/past/unparseable values. */
function shortResetOrUnknown(resetsAt: number | string | null | undefined): string {
  if (resetsAt === null || resetsAt === undefined) return "unknown";
  const unixSeconds =
    typeof resetsAt === "number"
      ? resetsAt
      : (() => {
          const ms = Date.parse(resetsAt);
          return Number.isFinite(ms) ? ms / 1000 : Number.NaN;
        })();
  if (!Number.isFinite(unixSeconds)) return "unknown";
  return formatResetTime(unixSeconds) ?? "unknown";
}

/**
 * Provider window ids and display labels collapse into the short middle segment
 * of the statusline warning (`[Provider] pct% <here> · resets …`).
 *
 * Wire ids (primary/secondary, five_hour/seven_day) and friendly labels from
 * every plan panel land here so the statusline never shows raw scope keys or a
 * redundant provider prefix:
 *
 * - Anthropic: five_hour / seven_day / seven_day_fable / overage
 * - Codex: primary|secondary (wire) → session|weekly; product window is weekly
 * - Kimi Code: "Weekly limit", "5h limit", duration labels from /usages
 * - MiniMax: "general · 5-hour", "video · weekly"
 * - Z.AI/GLM: "5-hour prompt pool", "Weekly quota", "MCP quota"
 * - xAI: "Monthly credits"
 */
function mapWindowOrFamilyLabel(label: string): string {
  const raw = label.trim();
  if (raw.length === 0) return raw;
  let text = raw
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\s*·\s*/g, " · ")
    .trim();
  text = text
    .replace(
      /^(anthropic|codex|kimi(?:\s+(?:code|for\s+coding))?|minimax|antigravity|deepseek|xai|openai(?:\s+custom)?|glm|z\.?\s*ai)\s+/i,
      "",
    )
    .replace(/\s+(limit|quota|credits)$/i, "")
    .trim();
  const lc = text.toLowerCase();

  // Codex wire keys: primary/secondary are never UI text. Product is weekly-only.
  if (lc === "primary" || lc === "secondary") return "weekly";

  // Exact / near-exact window ids.
  if (
    lc === "five hour" ||
    lc === "fivehour" ||
    lc === "session" ||
    lc === "5 hour" ||
    lc === "5h" ||
    lc === "5 hour prompt pool" ||
    lc === "prompt pool"
  ) {
    return "session";
  }
  if (lc === "seven day" || lc === "sevenday" || lc === "weekly" || lc === "weekly all") {
    return "weekly";
  }
  if (lc === "daily" || lc === "day" || lc === "1d") return "daily";
  if (lc === "monthly" || lc === "month" || lc === "monthly credit") return "monthly";
  if (lc === "seven day fable" || lc === "fable" || lc === "fable weekly") return "Fable weekly";
  if (lc === "overage" || lc === "extra usage" || lc === "extra") return "extra usage";
  if (lc === "mcp" || lc === "mcp quota" || lc === "time limit") return "MCP";
  if (lc === "claude gpt" || lc === "claude/gpt") return "Claude/GPT";
  if (lc === "spark") return "Spark";
  if (lc === "gemini") return "Gemini";
  if (lc === "token" || lc === "tokens") return "tokens";

  // MiniMax / model·window: "general · 5-hour", "video · weekly".
  const modelWindow = text.match(/^(.+?)\s*·\s*(.+)$/);
  if (modelWindow) {
    const model = modelWindow[1]!.trim();
    const window = mapWindowOrFamilyLabel(modelWindow[2]!);
    if (model.length > 0) return `${model} · ${window}`;
    return window;
  }

  // Kimi duration labels from window.timeUnit ("5h", "1d", "60m").
  if (/^\d+\s*h$/i.test(lc) || /^\d+\s*hour(?:s)?$/i.test(lc)) {
    const hours = Number.parseInt(lc, 10);
    if (Number.isFinite(hours) && hours > 0 && hours <= 6) return "session";
    if (Number.isFinite(hours) && hours >= 24 && hours < 168) return "daily";
    if (Number.isFinite(hours) && hours >= 168) return "weekly";
  }
  if (/^\d+\s*m$/i.test(lc) || /^\d+\s*min(?:ute)?s?$/i.test(lc)) {
    const minutes = Number.parseInt(lc, 10);
    if (Number.isFinite(minutes) && minutes > 0 && minutes <= 360) return "session";
  }
  if (/^\d+\s*d$/i.test(lc) || /^\d+\s*day(?:s)?$/i.test(lc)) {
    const days = Number.parseInt(lc, 10);
    if (Number.isFinite(days) && days === 1) return "daily";
    if (Number.isFinite(days) && days >= 7) return "weekly";
  }

  // Phrase leftovers after strip.
  if (/\bmcp\b/i.test(lc)) return "MCP";
  if (/\b(five\s*hour|5\s*h(?:our)?|session|prompt\s*pool)\b/i.test(lc)) return "session";
  if (/\b(seven\s*day|weekly)\b/i.test(lc) && !/\bfable\b/i.test(lc)) return "weekly";
  if (/\bfable\b/i.test(lc)) return "Fable weekly";
  if (/\bmonthly\b|\bcredits?\b/i.test(lc)) return "monthly";
  if (/\bdaily\b/i.test(lc)) return "daily";

  return text.length > 0 ? text : raw;
}

/**
 * Central per-scope quota warning formatter. Every scoped-quota-warning
 * consumer (applyScopedQuotaWarnings and, transitively, Anthropic/Codex/
 * Antigravity's per-scope observations) renders through this single template
 * so a wording or threshold change never drifts between providers:
 *
 *   `[provider display name] <pct>% <Window-or-family> · resets <short-time-or-unknown>`
 *
 * `pct` keeps a meaningful decimal (e.g. 99.9) instead of being floored, and
 * `windowOrFamily` is passed as plain text (a window id, a family id, or a
 * display label) rather than assembled into a provider-specific sentence.
 */
export function formatQuotaWarningMessage(
  provider: ProviderId,
  pct: number,
  windowOrFamily: string,
  resetsAt: number | string | null | undefined,
): string {
  const providerLabel = getProviderConfig(provider)?.provider.label ?? provider;
  let mappedType = mapWindowOrFamilyLabel(windowOrFamily);
  // Codex product surface is weekly-only; never expose session/primary/secondary.
  if (provider === "codex" && (mappedType === "session" || mappedType === "daily")) {
    mappedType = "weekly";
  }
  return `[${providerLabel}] ${formatQuotaPercent(pct)}% ${capitalizeWindowLabel(mappedType)} · resets ${shortResetOrUnknown(resetsAt)}`;
}
