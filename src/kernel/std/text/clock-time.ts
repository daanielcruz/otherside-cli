const CLOCK_TIME_FORMAT = {
  today: { hour: "numeric", minute: "2-digit" },
  week: { weekday: "long", hour: "numeric", minute: "2-digit" },
  older: { weekday: "long", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" },
} as const satisfies Record<string, Intl.DateTimeFormatOptions>;

const DAY_MS = 86_400_000;

function timeLocale(): string | undefined {
  const raw = process.env.LC_ALL || process.env.LC_TIME || process.env.LANG || "";
  if (raw === "" || raw === "C" || raw === "POSIX") return undefined;
  const tag = raw.split(".")[0]?.split("@")[0]?.replaceAll("_", "-");
  if (!tag) return undefined;
  try {
    new Intl.DateTimeFormat(tag);
    return tag;
  } catch {
    return undefined;
  }
}

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** A moment's clock time, widened with the weekday and date as it ages. */
export function formatClockTime(at: Date, now: Date = new Date()): string {
  const days = Math.round((startOfDay(now) - startOfDay(at)) / DAY_MS);
  const age = days === 0 ? "today" : days > 0 && days < 7 ? "week" : "older";
  return new Intl.DateTimeFormat(timeLocale(), CLOCK_TIME_FORMAT[age]).format(at);
}
