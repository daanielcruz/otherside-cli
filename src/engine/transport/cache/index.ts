import type { CacheControl } from "@/kernel/std/types/message.ts";

export const CACHE_CONTROL_1H: CacheControl = { type: "ephemeral", ttl: "1h" };
export const CACHE_CONTROL_5M: CacheControl = { type: "ephemeral", ttl: "5m" };
export const CACHE_CONTROL_1H_GLOBAL: CacheControl = {
  type: "ephemeral",
  ttl: "1h",
  scope: "global",
};
