import { expect, test } from "bun:test";
import { formatArchivedOutputNotice } from "../files.ts";

test("formats archived output sizes through the shared compact description owner", () => {
  const notice = formatArchivedOutputNotice({
    path: "/saved/output.txt",
    characterCount: 1536,
    structured: false,
    preview: "sample",
    truncated: true,
  });

  expect(notice).toContain("Output too large (1.5KB). Full output saved to: /saved/output.txt");
});
