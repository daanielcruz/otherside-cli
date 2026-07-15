import { describe, expect, test } from "bun:test";
import { DESIGN_SKILLS } from "./skills";

describe("design authoring skills", () => {
  test("declares the host-owned mobile frame contract for interfaces and prototypes", () => {
    for (const skill of [DESIGN_SKILLS.interface, DESIGN_SKILLS.prototype]) {
      expect(skill).toContain('<meta name="design-device" content="mobile">');
      expect(skill).toContain("390×844 handset shell");
      expect(skill).toContain("full-bleed app screen");
      expect(skill).toContain("never draw the outer handset or bezel");
    }
  });

  test("declares typed file-backed design controls", () => {
    expect(DESIGN_SKILLS.tweakable).toContain(
      '<script type="application/json" data-design-controls>{...}</script>',
    );
    expect(DESIGN_SKILLS.tweakable).toContain('"text"|"color"|"number"|"range"|"boolean"|"select"');
    expect(DESIGN_SKILLS.tweakable).toContain("design-control-change");
    expect(DESIGN_SKILLS.tweakable).not.toContain("window.DESIGN_TWEAKS");
  });
});
