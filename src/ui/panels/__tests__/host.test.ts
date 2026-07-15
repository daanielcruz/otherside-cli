import { describe, expect, test } from "bun:test";
import { overlayOwnsDismiss } from "../host.tsx";

describe("overlay dismiss ownership", () => {
  test("keeps stateful picker Escape handling out of the host", () => {
    expect(overlayOwnsDismiss("resume")).toBe(true);
    expect(overlayOwnsDismiss("rewind")).toBe(true);
  });

  test("keeps the existing plugin ownership and host-owned defaults", () => {
    expect(overlayOwnsDismiss("plugins")).toBe(true);
    expect(overlayOwnsDismiss("model")).toBe(false);
  });
});
