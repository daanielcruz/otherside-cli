import { describe, expect, test } from "bun:test";
import { DESIGN_FORK_BODY } from "./harness";
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

  test("exposes the full template medium skill roster", () => {
    for (const name of [
      "interface",
      "prototype",
      "animation",
      "document",
      "resume",
      "presentation",
      "wireframe",
      "research",
      "object3d",
      "email",
      "flier",
      "brochure",
      "website",
      "social",
      "dataviz",
      "pairing",
      "diagram",
    ]) {
      expect(DESIGN_SKILLS[name]?.length ?? 0).toBeGreaterThan(40);
    }
  });

  test("defers artifact topology to the selected medium", () => {
    expect(DESIGN_FORK_BODY).toContain("loaded medium's methodology owns artifact topology");
    expect(DESIGN_FORK_BODY).toContain("slides, scenes, pages, and options stay together");
    expect(DESIGN_FORK_BODY).not.toContain("add a new screen per app screen, slide, or scene");
    expect(DESIGN_FORK_BODY).not.toContain("Each slide or scene is its own screen");
  });

  test("presentation skill requires one file with one multi-section deck-stage", () => {
    const skill = DESIGN_SKILLS.presentation;
    expect(skill).toContain("ONE .os.html file");
    expect(skill).toContain("<deck-stage>");
    expect(skill).toContain("Never split slides into separate files");
    expect(skill).toContain("Forbidden on <section> selectors");
    expect(skill).toContain("data-speaker-notes");
  });

  test("social skill uses the host image slot for replaceable imagery", () => {
    expect(DESIGN_SKILLS.social).toContain("<image-slot>");
    expect(DESIGN_SKILLS.social).toContain("stable unique id");
    expect(DESIGN_SKILLS.social).toContain("reload persistence");
  });

  test("document and resume skills require the host doc-page shell", () => {
    expect(DESIGN_SKILLS.document).toContain("<doc-page");
    expect(DESIGN_SKILLS.document).toContain('size="letter"');
    expect(DESIGN_SKILLS.document).not.toContain("doc-frame");
    expect(DESIGN_SKILLS.resume).toContain("<doc-page");
  });
});
