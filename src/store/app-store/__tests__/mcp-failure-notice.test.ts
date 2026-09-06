import { beforeEach, describe, expect, test } from "bun:test";
import { appStore } from "@/store/app-store/index.ts";
import {
  DEFAULT_EPHEMERAL_MS,
  expireCurrentNotice,
  RightNoticeKey,
  resetRightRegion,
  submitMcpFailuresNotice,
} from "@/store/app-store/right-region-notices.ts";

describe("submitMcpFailuresNotice", () => {
  beforeEach(() => {
    resetRightRegion();
  });

  test("a boot with nothing failing submits no notice", () => {
    submitMcpFailuresNotice(0);
    const region = appStore.getState().rightRegion;
    expect(region.ephemeralCurrent).toBeNull();
    expect(region.ephemeralQueue).toEqual([]);
  });

  test("a single failure composes the singular notice with its dim hint", () => {
    submitMcpFailuresNotice(1);
    const current = appStore.getState().rightRegion.ephemeralCurrent;
    expect(current?.key).toBe(RightNoticeKey.mcpFailure);
    expect(current?.text).toBe("1 MCP server failed");
    expect(current?.dimSuffix).toBe(" · /mcp");
    expect(current?.tone).toBe("error");
  });

  test("several failures pluralize the noun", () => {
    submitMcpFailuresNotice(2);
    expect(appStore.getState().rightRegion.ephemeralCurrent?.text).toBe("2 MCP servers failed");
  });

  test("the notice expires on the queue's default timeout", () => {
    const submittedAt = Date.now();
    submitMcpFailuresNotice(1);
    const current = appStore.getState().rightRegion.ephemeralCurrent;
    expect(current?.durationMs).toBe(DEFAULT_EPHEMERAL_MS);
    const deadline = current?.expiresAt ?? 0;
    expect(deadline).toBeGreaterThanOrEqual(submittedAt + DEFAULT_EPHEMERAL_MS);

    expireCurrentNotice(deadline - 1);
    expect(appStore.getState().rightRegion.ephemeralCurrent?.key).toBe(RightNoticeKey.mcpFailure);
    expireCurrentNotice(deadline);
    expect(appStore.getState().rightRegion.ephemeralCurrent).toBeNull();
  });
});
