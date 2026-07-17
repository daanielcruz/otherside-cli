import { describe, expect, test } from "bun:test";
import { SESSION_EVENTS_TIMEOUT_MS } from "@/backend/shared/api.ts";
import { RELAY_POST_TIMEOUT_MS } from "./outbound.ts";

describe("relay request deadlines", () => {
  test("bounds durable polls and outbound posts", () => {
    expect(SESSION_EVENTS_TIMEOUT_MS).toBe(10_000);
    expect(RELAY_POST_TIMEOUT_MS).toBe(15_000);
  });
});
