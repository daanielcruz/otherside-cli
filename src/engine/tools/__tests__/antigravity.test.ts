import { describe, expect, it, spyOn } from "bun:test";
import * as auth from "@/engine/providers/antigravity/auth.ts";
import * as transport from "@/engine/transport/http1-socket.ts";
import { searchAntigravity } from "../antigravity.ts";

async function* searchResponse(): AsyncIterable<Uint8Array> {
  yield Buffer.from(
    JSON.stringify({
      response: {
        candidates: [{ content: { parts: [{ text: "Search fixture answer" }] } }],
      },
    }),
  );
}

describe("grounded search request", () => {
  it("sends the web_search generateContent envelope on gemini-3.5-flash-lite", async () => {
    const tokens = spyOn(auth, "currentTokens").mockResolvedValue({
      accessToken: "access-placeholder",
      refreshToken: "refresh-placeholder",
      expiresAt: 0,
    });
    const project = spyOn(auth, "resolveProjectId").mockResolvedValue("project-fixture");
    const send = spyOn(transport, "sendSizedRequest").mockResolvedValue({
      status: 200,
      headers: new Map(),
      body: searchResponse(),
    });

    try {
      const result = await searchAntigravity(
        { query: "request fixture", allowedDomains: [], blockedDomains: [] },
        {
          provider: "antigravity",
          model: "gemini-3.8-flash",
          effort: "high",
          permissionMode: "default",
          sessionId: "search-fixture",
          cwd: "/workspace/fixture",
        },
      );
      expect(send).toHaveBeenCalledTimes(1);
      const [call, contentLengthAt] = send.mock.calls[0] ?? [];
      expect(call).toBeDefined();
      expect(contentLengthAt).toBe(1);
      if (!call) throw new Error("search request was not sent");
      const envelope: unknown = JSON.parse(call.payload.toString());
      expect(envelope).toEqual({
        project: "project-fixture",
        request: {
          contents: [{ role: "user", parts: [{ text: "request fixture" }] }],
          systemInstruction: {
            role: "user",
            parts: [{ text: expect.stringContaining("You are a search engine bot.") }],
          },
          tools: [
            {
              googleSearch: {
                enhancedContent: {
                  imageSearch: { maxResultCount: 5 },
                },
              },
            },
          ],
          generationConfig: { candidateCount: 1 },
        },
        model: "gemini-3.5-flash-lite",
        userAgent: "antigravity",
        requestType: "web_search",
      });
      expect(result.results).toEqual(["Search fixture answer"]);
    } finally {
      send.mockRestore();
      project.mockRestore();
      tokens.mockRestore();
    }
  });
});

function resetError(): Error {
  const error = new Error("read ECONNRESET");
  Object.assign(error, { code: "ECONNRESET" });
  return error;
}

function searchContext() {
  return {
    provider: "antigravity",
    model: "gemini-3.8-flash",
    effort: "high",
    permissionMode: "default",
    sessionId: "search-retry",
    cwd: "/workspace/fixture",
  } as Parameters<typeof searchAntigravity>[1];
}

function mockedAuth() {
  const tokens = spyOn(auth, "currentTokens").mockResolvedValue({
    accessToken: "access-placeholder",
    refreshToken: "refresh-placeholder",
    expiresAt: 0,
  });
  const project = spyOn(auth, "resolveProjectId").mockResolvedValue("project-fixture");
  return () => {
    project.mockRestore();
    tokens.mockRestore();
  };
}

describe("grounded search connection failures", () => {
  it("recovers from a connection reset instead of failing the tool", async () => {
    const restoreAuth = mockedAuth();
    const send = spyOn(transport, "sendSizedRequest")
      .mockRejectedValueOnce(resetError())
      .mockResolvedValue({ status: 200, headers: new Map(), body: searchResponse() });

    try {
      const result = await searchAntigravity(
        { query: "reset fixture", allowedDomains: [], blockedDomains: [] },
        searchContext(),
      );
      expect(send).toHaveBeenCalledTimes(2);
      expect(result.results).toEqual(["Search fixture answer"]);
    } finally {
      send.mockRestore();
      restoreAuth();
    }
  });

  it("gives up after the attempt budget rather than retrying forever", async () => {
    const restoreAuth = mockedAuth();
    const send = spyOn(transport, "sendSizedRequest").mockRejectedValue(resetError());

    try {
      await expect(
        searchAntigravity(
          { query: "reset fixture", allowedDomains: [], blockedDomains: [] },
          searchContext(),
        ),
      ).rejects.toThrow(/ECONNRESET/);
      expect(send).toHaveBeenCalledTimes(3);
    } finally {
      send.mockRestore();
      restoreAuth();
    }
  });

  it("does not retry a failure the connection cannot explain", async () => {
    const restoreAuth = mockedAuth();
    const send = spyOn(transport, "sendSizedRequest").mockRejectedValue(
      new Error("malformed request envelope"),
    );

    try {
      await expect(
        searchAntigravity(
          { query: "reset fixture", allowedDomains: [], blockedDomains: [] },
          searchContext(),
        ),
      ).rejects.toThrow(/malformed request envelope/);
      expect(send).toHaveBeenCalledTimes(1);
    } finally {
      send.mockRestore();
      restoreAuth();
    }
  });
});
