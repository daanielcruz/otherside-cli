import { afterEach, describe, expect, test } from "bun:test";
import { cortexFetch, cortexUrl } from "@/backend/shared/cortex.ts";

const DEFAULT_URL = "https://api.othersidecli.com";

describe("cortexUrl override allowlist", () => {
  afterEach(() => {
    delete process.env.OTHERSIDE_CORTEX_URL;
    delete process.env.OTHERSIDE_BACKEND_URL;
  });

  test("default", () => {
    expect(cortexUrl()).toBe(DEFAULT_URL);
  });

  test("staging othersidecli.com is allowed", () => {
    process.env.OTHERSIDE_CORTEX_URL = "https://staging.othersidecli.com";
    expect(cortexUrl()).toBe("https://staging.othersidecli.com");
  });

  test("localhost http is allowed", () => {
    process.env.OTHERSIDE_CORTEX_URL = "http://localhost:8787";
    expect(cortexUrl()).toBe("http://localhost:8787");
  });

  test("supabase.co is rejected", () => {
    process.env.OTHERSIDE_CORTEX_URL = "https://abcd1234.supabase.co";
    expect(cortexUrl()).toBe(DEFAULT_URL);
  });

  test("arbitrary host is rejected", () => {
    process.env.OTHERSIDE_CORTEX_URL = "https://evil.example.com";
    expect(cortexUrl()).toBe(DEFAULT_URL);
  });
});

describe("cortexFetch", () => {
  test("passes the caller abort signal to fetch", async () => {
    const originalFetch = globalThis.fetch;
    const controller = new AbortController();
    let receivedSignal: AbortSignal | null | undefined;
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      receivedSignal = init?.signal;
      return Response.json({ status: "success", data: { ok: true }, request_id: "req-1" });
    }) as unknown as typeof fetch;

    try {
      await cortexFetch("/health", { signal: controller.signal });
      expect(receivedSignal).toBe(controller.signal);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
