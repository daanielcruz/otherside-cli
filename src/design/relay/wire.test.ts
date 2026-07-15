import { afterEach, describe, expect, test } from "bun:test";
import { designWebUrl } from "./wire.ts";

const previousOrigin = process.env.OTHERSIDE_DESIGN_WEB_ORIGIN;

afterEach(() => {
  if (previousOrigin === undefined) delete process.env.OTHERSIDE_DESIGN_WEB_ORIGIN;
  else process.env.OTHERSIDE_DESIGN_WEB_ORIGIN = previousOrigin;
});

describe("designWebUrl", () => {
  test("launches through an open token and keeps cli_pub in the fragment", () => {
    const url = designWebUrl("open_token_123", "cli_pub_456");
    expect(url).toBe("https://design.othersidecli.com/open/open_token_123#k=cli_pub_456");
  });

  test("trims the configured origin", () => {
    process.env.OTHERSIDE_DESIGN_WEB_ORIGIN = "http://localhost:5173///";
    const url = designWebUrl("token", "pub");
    expect(url).toBe("http://localhost:5173/open/token#k=pub");
  });

  test("encodes the open token path segment", () => {
    const url = designWebUrl("token/with/slash", "pub");
    expect(url).toBe("https://design.othersidecli.com/open/token%2Fwith%2Fslash#k=pub");
  });
});
