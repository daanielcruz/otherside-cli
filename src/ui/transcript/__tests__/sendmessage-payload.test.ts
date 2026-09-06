import { describe, expect, it } from "bun:test";
import { payloadFromResult } from "@/ui/transcript/tool-render/payload.ts";

function sendMessagePayload(result: unknown): ReturnType<typeof payloadFromResult> {
  return payloadFromResult({
    name: "SendMessage",
    content: JSON.stringify(result),
    args: { to: "fork-1", message: "keep going" },
  });
}

describe("SendMessage transcript payload", () => {
  it("shows the routing warning instead of a field count", () => {
    const warning =
      "routing ignored: agent fork-1 already runs codex/gpt-5.5. Omit `routing` unless the agent must move to a different provider/model.";
    expect(sendMessagePayload({ delivered: true, to: "fork-1", resumed: false, warning })).toEqual({
      kind: "preview",
      text: warning,
    });
  });

  it("shows the refusal reason when delivery failed", () => {
    const reason = 'MultiModelForkDisabled: the "Multi-model fork" setting is off.';
    expect(
      sendMessagePayload({
        delivered: false,
        to: "fork-1",
        code: "route_rejected",
        reason,
        knownAgents: "fork-1",
      }),
    ).toEqual({ kind: "preview", text: reason });
  });

  it("leaves a plain delivery to the generic preview", () => {
    expect(sendMessagePayload({ delivered: true, to: "fork-1", resumed: true })).toEqual({
      kind: "preview",
      text: "3 fields",
    });
  });
});
