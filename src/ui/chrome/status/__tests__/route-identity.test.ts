import { describe, expect, it } from "bun:test";
import { registerAllProviders } from "@/engine/providers/bootstrap.ts";
import { Broker, type BrokerState } from "@/store/app-store/broker.ts";
import { dispatch } from "@/store/app-store/index.ts";
import { readStringViewBrokerState } from "@/ui/chrome/status/string-view-state.ts";

registerAllProviders();

const MIRRORED: BrokerState = {
  provider: "codex",
  model: "gpt-5.6-sol",
  effort: "high",
  fastMode: false,
  permissionMode: "default",
  orchestrationMode: "disabled",
};

const LIVE: BrokerState = {
  ...MIRRORED,
  provider: "anthropic",
  model: "claude-opus-5",
};

describe("chrome route identity", () => {
  it("answers from the live broker, not the store mirror it may be ahead of", () => {
    dispatch({ type: "engine/setSlice", key: "broker", value: MIRRORED });
    expect(readStringViewBrokerState().model).toBe("gpt-5.6-sol");

    const live = new Broker(LIVE, {
      findModel: (route) => ({ provider: route.provider }),
      effortLevelsForModel: () => ["low", "medium", "high"],
      defaultEffortForModel: () => "high",
      defaultModelForProvider: (provider) => `${provider}-default`,
    });

    expect(readStringViewBrokerState().provider).toBe("anthropic");
    expect(readStringViewBrokerState().model).toBe("claude-opus-5");

    live.dispatch({ kind: "cycle_permission_mode" });
    // Read straight after the change, before any mirror write could land.
    expect(readStringViewBrokerState().permissionMode).toBe(live.read().permissionMode);
    expect(readStringViewBrokerState().permissionMode).not.toBe(MIRRORED.permissionMode);

    live.release();
    expect(readStringViewBrokerState().model).toBe("gpt-5.6-sol");
  });
});
