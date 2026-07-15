import { describe, expect, it } from "bun:test";
import { awaitQuestion, resolveQuestion } from "@/design/pending.ts";

describe("question responses", () => {
  it("accepts exact retries for resolved questions but rejects changed and unknown answers", async () => {
    const answer = awaitQuestion("question-retry");
    expect(resolveQuestion("question-retry", '{"choice":"dark"}')).toBe(true);
    await expect(answer).resolves.toBe('{"choice":"dark"}');
    expect(resolveQuestion("question-retry", '{"choice":"dark"}')).toBe(true);
    expect(resolveQuestion("question-retry", '{"choice":"light"}')).toBe(false);
    expect(resolveQuestion("unknown-question", '{"choice":"dark"}')).toBe(false);
  });

  it("retains only the 64 most recent resolved question IDs", async () => {
    const answers: Promise<string>[] = [];
    for (let index = 0; index < 65; index += 1) {
      const requestId = `question-cache-${index}`;
      answers.push(awaitQuestion(requestId));
      expect(resolveQuestion(requestId, String(index))).toBe(true);
    }
    await expect(Promise.all(answers)).resolves.toHaveLength(65);
    expect(resolveQuestion("question-cache-0", "0")).toBe(false);
    expect(resolveQuestion("question-cache-64", "64")).toBe(true);
  });

  it("clears a prior response when the same question ID is awaited again", async () => {
    const first = awaitQuestion("question-reused");
    resolveQuestion("question-reused", "first");
    await expect(first).resolves.toBe("first");

    const second = awaitQuestion("question-reused");
    expect(resolveQuestion("question-reused", "first")).toBe(true);
    await expect(second).resolves.toBe("first");
  });
});
