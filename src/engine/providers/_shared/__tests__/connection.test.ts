import { describe, expect, it } from "bun:test";
import { connectionHeaders, connectionInit } from "@/engine/providers/_shared/connection.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";

const ctx = (freshConnection?: boolean): RequestContext =>
  ({ ...(freshConnection !== undefined ? { freshConnection } : {}) }) as RequestContext;

describe("fresh connection fetch options", () => {
  it("does not alter healthy requests", () => {
    expect(connectionInit(ctx())).toEqual({});
    expect(connectionHeaders(ctx())).toEqual({});
  });

  it("disables pool reuse and asks the peer to close after an idle timeout", () => {
    expect(connectionInit(ctx(true))).toEqual({ keepalive: false });
    expect(connectionHeaders(ctx(true))).toEqual({ Connection: "close" });
  });
});
