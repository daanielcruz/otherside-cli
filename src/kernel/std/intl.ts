let graphemeSegmenter: Intl.Segmenter | null = null;
let wordSegmenter: Intl.Segmenter | null = null;

export function sharedGraphemeSegmenter(): Intl.Segmenter {
  if (!graphemeSegmenter) {
    graphemeSegmenter = new Intl.Segmenter(undefined, {
      granularity: "grapheme",
    });
  }
  return graphemeSegmenter;
}

export function firstGrapheme(text: string): string {
  if (!text) return "";
  const segments = sharedGraphemeSegmenter().segment(text);
  const first = segments[Symbol.iterator]().next().value;
  return first?.segment ?? "";
}

export function lastGrapheme(text: string): string {
  if (!text) return "";
  let last = "";
  for (const { segment } of sharedGraphemeSegmenter().segment(text)) {
    last = segment;
  }
  return last;
}

export function getWordSegmenter(): Intl.Segmenter {
  if (!wordSegmenter) {
    wordSegmenter = new Intl.Segmenter(undefined, { granularity: "word" });
  }
  return wordSegmenter;
}

const rtfCache = new Map<string, Intl.RelativeTimeFormat>();

export function createRelativeTimeFormat(
  style: "long" | "short" | "narrow",
  numeric: "always" | "auto",
): Intl.RelativeTimeFormat {
  const key = `${style}:${numeric}`;
  let rtf = rtfCache.get(key);
  if (!rtf) {
    rtf = new Intl.RelativeTimeFormat("en", { style, numeric });
    rtfCache.set(key, rtf);
  }
  return rtf;
}

let cachedTimeZone: string | null = null;

export function getTimeZone(): string {
  if (!cachedTimeZone) {
    cachedTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  }
  return cachedTimeZone;
}

export function getShortTimeZone(date = new Date()): string {
  try {
    return (
      Intl.DateTimeFormat("en-US", { timeZoneName: "short" })
        .formatToParts(date)
        .find((p) => p.type === "timeZoneName")?.value ?? "UTC"
    );
  } catch {
    return "UTC";
  }
}

/** Human reset text ("2:50pm (GMT-3)"; long form beyond 24h); null for past/invalid times. */
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

let cachedSystemLocaleLanguage: string | undefined | null = null;

export function systemLocaleLanguage(): string | undefined {
  if (cachedSystemLocaleLanguage === null) {
    try {
      const locale = Intl.DateTimeFormat().resolvedOptions().locale;
      cachedSystemLocaleLanguage = new Intl.Locale(locale).language;
    } catch {
      cachedSystemLocaleLanguage = undefined;
    }
  }
  return cachedSystemLocaleLanguage;
}
