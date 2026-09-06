import { describe, expect, it, spyOn } from "bun:test";
import * as auth from "@/engine/providers/antigravity/auth.ts";
import * as transport from "@/engine/transport/http1-socket.ts";
import { searchAntigravity } from "../antigravity.ts";

async function* searchResponse(): AsyncIterable<Uint8Array> {
  yield Buffer.from(
    'data: {"response":{"candidates":[{"content":{"parts":[{"text":"Search fixture answer"}]}}]}}\n\n',
  );
}

describe("grounded search request", () => {
  it("uses Gemini 3.8 while preserving the search tool and thinking budget", async () => {
    const tokens = spyOn(auth, "currentTokens").mockResolvedValue({
      accessToken: "access-placeholder",
      refreshToken: "refresh-placeholder",
      expiresAt: 0,
    });
    const project = spyOn(auth, "resolveProjectId").mockResolvedValue("project-fixture");
    const authorization = spyOn(auth, "authorizationHeader").mockResolvedValue(
      "Bearer access-placeholder",
    );
    const send = spyOn(transport, "sendChunkedRequest").mockResolvedValue({
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
      const call = send.mock.calls[0]?.[0];
      expect(call).toBeDefined();
      if (!call) throw new Error("search request was not sent");
      const envelope: unknown = JSON.parse(call.payload.toString());
      expect(envelope).toEqual({
        project: "project-fixture",
        requestId: expect.any(String),
        request: {
          contents: [{ role: "user", parts: [{ text: "request fixture" }] }],
          systemInstruction: {
            parts: [{ text: expect.stringContaining("execute the user's search query") }],
          },
          tools: [{ googleSearch: {} }],
          generationConfig: {
            temperature: 0,
            thinkingConfig: { includeThoughts: true, thinkingBudget: 1001 },
          },
        },
        model: "gemini-3.8-flash-high",
        userAgent: "antigravity",
        requestType: "agent",
        enabledCreditTypes: ["GOOGLE_ONE_AI"],
      });
      expect(result.results).toEqual(["Search fixture answer"]);
    } finally {
      send.mockRestore();
      authorization.mockRestore();
      project.mockRestore();
      tokens.mockRestore();
    }
  });
});
