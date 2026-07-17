import { describe, expect, test } from "bun:test";
import { promptOwnsArrowNavigation } from "../arrow-navigation.ts";

describe("prompt arrow navigation ownership", () => {
  test("releases bare arrows while an agent view owns bullet navigation", () => {
    expect(
      promptOwnsArrowNavigation({
        locked: true,
        upArrow: true,
        downArrow: false,
        slashOptionCount: 0,
      }),
    ).toBe(false);
    expect(
      promptOwnsArrowNavigation({
        locked: true,
        upArrow: false,
        downArrow: true,
        slashOptionCount: 0,
      }),
    ).toBe(false);
  });

  test("keeps slash-menu arrow navigation active inside an agent view", () => {
    expect(
      promptOwnsArrowNavigation({
        locked: true,
        upArrow: true,
        downArrow: false,
        slashOptionCount: 3,
      }),
    ).toBe(true);
  });

  test("does not lock non-arrow input or main-session arrows", () => {
    expect(
      promptOwnsArrowNavigation({
        locked: true,
        upArrow: false,
        downArrow: false,
        slashOptionCount: 0,
      }),
    ).toBe(true);
    expect(
      promptOwnsArrowNavigation({
        locked: false,
        upArrow: true,
        downArrow: false,
        slashOptionCount: 0,
      }),
    ).toBe(true);
  });
});
