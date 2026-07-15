import { afterEach, describe, expect, it } from "bun:test";
import {
  clearPendingPluginCommandResult,
  consumePendingPluginCommandResult,
  peekPendingPluginCommandResult,
  setPendingPluginCommandResult,
} from "@/ui/panels/plugins/command-result.ts";

describe("plugin command result bridge", () => {
  afterEach(() => {
    clearPendingPluginCommandResult();
  });

  it("stores, peeks, and consumes feedback for the plugins panel", () => {
    setPendingPluginCommandResult("  Installed demo@claude-plugins-official  ");
    expect(peekPendingPluginCommandResult()).toBe("Installed demo@claude-plugins-official");
    expect(consumePendingPluginCommandResult()).toBe("Installed demo@claude-plugins-official");
    expect(consumePendingPluginCommandResult()).toBeNull();
  });

  it("ignores empty feedback", () => {
    setPendingPluginCommandResult("   ");
    expect(peekPendingPluginCommandResult()).toBeNull();
  });
});
