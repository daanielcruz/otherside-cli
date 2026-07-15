import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeDevtools, providerEndpoint, resetDevtoolsForTest } from "@/devtools/config.ts";

const originalConfig = process.env.OTHERSIDE_DEVTOOLS_CONFIG;
const roots: string[] = [];

function config(value: unknown): string {
  const root = mkdtempSync(join(tmpdir(), "otherside-devtools-"));
  roots.push(root);
  const path = join(root, "config.json");
  writeFileSync(path, JSON.stringify(value));
  return path;
}

afterEach(() => {
  if (originalConfig === undefined) delete process.env.OTHERSIDE_DEVTOOLS_CONFIG;
  else process.env.OTHERSIDE_DEVTOOLS_CONFIG = originalConfig;
  delete process.env.OTHERSIDE_RENDER_DIAG;
  resetDevtoolsForTest();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("central devtools config", () => {
  it("leaves production endpoints and environment unchanged when absent", () => {
    delete process.env.OTHERSIDE_DEVTOOLS_CONFIG;
    resetDevtoolsForTest();
    initializeDevtools();
    expect(providerEndpoint("codex", "responses", "https://production.invalid/responses")).toBe(
      "https://production.invalid/responses",
    );
  });

  it("applies declared diagnostics and provider endpoints", () => {
    process.env.OTHERSIDE_DEVTOOLS_CONFIG = config({
      version: 1,
      environment: { OTHERSIDE_RENDER_DIAG: "1" },
      providers: {
        codex: {
          responses: "https://127.0.0.1:8443/responses",
          responsesWs: "wss://127.0.0.1:8443/responses",
        },
      },
    });
    resetDevtoolsForTest();
    initializeDevtools();
    expect(process.env.OTHERSIDE_RENDER_DIAG).toBe("1");
    expect(providerEndpoint("codex", "responses", "fallback")).toBe(
      "https://127.0.0.1:8443/responses",
    );
    expect(providerEndpoint("codex", "responsesWs", "fallback")).toBe(
      "wss://127.0.0.1:8443/responses",
    );
  });

  it("rejects credential-like environment overrides", () => {
    process.env.OTHERSIDE_DEVTOOLS_CONFIG = config({
      version: 1,
      environment: { OTHERSIDE_API_KEY: "secret" },
    });
    resetDevtoolsForTest();
    expect(() => initializeDevtools()).toThrow("environment override is not allowed");
  });

  it("rejects unknown provider endpoints", () => {
    process.env.OTHERSIDE_DEVTOOLS_CONFIG = config({
      version: 1,
      providers: { codex: { arbitrary: "https://127.0.0.1" } },
    });
    resetDevtoolsForTest();
    expect(() => initializeDevtools()).toThrow("unknown devtools endpoint");
  });
});
