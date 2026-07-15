import { describe, expect, test } from "bun:test";
import {
  applyTrailingCacheControl,
  composeAnthropicMessages,
} from "@/engine/providers/anthropic/compose.ts";
import { sanitizeMessages } from "@/engine/translator/sanitize.ts";
import type { ComposedHarness } from "@/harness/composer/injections.ts";
import type { Message } from "@/kernel/std/types/message.ts";

function harness(overrides: Partial<ComposedHarness> = {}): ComposedHarness {
  return {
    layers: [],
    combined: "",
    systemBlocks: [],
    userPrepend: [],
    ...overrides,
  };
}

function firstUserText(messages: Message[]): string {
  const user = messages.find((m) => m.role === "user");
  const block = user?.content.find((b) => b.type === "text");
  return block?.type === "text" ? block.text : "";
}

const PREAMBLE_LINE = "As you answer the user's questions, you can use the following context:";
const IMPORTANT_LINE = "IMPORTANT: this context may or may not be relevant to your tasks.";

describe("composeAnthropicMessages — userPrepend bundle envelope (Lock §20 wire parity)", () => {
  test("emits ONE preamble and ONE IMPORTANT line per bundle (no duplication)", () => {
    const result = composeAnthropicMessages(
      harness({
        userPrepend: [
          {
            text: "# currentDate\nToday's date is 2026-06-19.\n",
            bundleKey: "user-context",
          },
        ],
      }),
      [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    );
    const userBody = firstUserText(result);
    const preambleCount = userBody.split(PREAMBLE_LINE).length - 1;
    const importantCount = userBody.split(IMPORTANT_LINE).length - 1;
    expect(preambleCount).toBe(1);
    expect(importantCount).toBe(1);
  });

  test("wraps userPrepend in exactly ONE <system-reminder> envelope", () => {
    const result = composeAnthropicMessages(
      harness({
        userPrepend: [
          { text: "# currentDate\nToday's date is 2026-06-19.\n", bundleKey: "user-context" },
        ],
      }),
      [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    );
    const userBody = firstUserText(result);
    const openCount = userBody.split("<system-reminder>").length - 1;
    const closeCount = userBody.split("</system-reminder>").length - 1;
    expect(openCount).toBe(1);
    expect(closeCount).toBe(1);
  });

  test("preserves the raw user-context body without re-headering", () => {
    const result = composeAnthropicMessages(
      harness({
        userPrepend: [
          {
            text: "# currentDate\nToday's date is 2026-06-19.\n# gitStatus\nclean\n",
            bundleKey: "user-context",
          },
        ],
      }),
      [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    );
    const userBody = firstUserText(result);
    expect(userBody).toContain("# currentDate\nToday's date is 2026-06-19.");
    expect(userBody).toContain("# gitStatus\nclean");
    expect(userBody).not.toContain("# user-context\n# currentDate");
  });

  test("empty userPrepend short-circuits and emits no envelope", () => {
    const result = composeAnthropicMessages(harness({ userPrepend: [] }), [
      { role: "user", content: [{ type: "text", text: "alone" }] },
    ]);
    const userBody = firstUserText(result);
    expect(userBody).not.toContain("<system-reminder>");
    expect(userBody).toBe("alone");
  });
});

describe("composeAnthropicMessages — phase-tagged consolidateHarnessBlocks (Option B)", () => {
  test("static layers fold into ONE block with global-scope cache", () => {
    const result = composeAnthropicMessages(
      harness({
        systemBlocks: [
          { text: "STATIC_A", phase: "static" },
          { text: "STATIC_B", phase: "static" },
        ],
      }),
      [{ role: "user", content: [{ type: "text", text: "x" }] }],
    );
    const system = result.find((m) => m.role === "system");
    const staticBlock = system?.content.find(
      (b) => b.type === "text" && b.text.includes("STATIC_A"),
    );
    expect(staticBlock).toBeDefined();
    expect(staticBlock?.type === "text" && staticBlock.text).toBe("STATIC_A\n\nSTATIC_B");
    const cc =
      staticBlock && "cache_control" in staticBlock ? staticBlock.cache_control : undefined;
    expect(cc).toMatchObject({ type: "ephemeral", ttl: "1h", scope: "global" });
  });

  test("dynamic layers fold into a separate org-scope block", () => {
    const result = composeAnthropicMessages(
      harness({
        systemBlocks: [
          { text: "STATIC", phase: "static" },
          { text: "DYN_1", phase: "dynamic" },
          { text: "DYN_2", phase: "dynamic" },
        ],
      }),
      [{ role: "user", content: [{ type: "text", text: "x" }] }],
    );
    const system = result.find((m) => m.role === "system");
    const dynBlock = system?.content.find((b) => b.type === "text" && b.text.includes("DYN_1"));
    expect(dynBlock).toBeDefined();
    expect(dynBlock?.type === "text" && dynBlock.text).toBe("DYN_1\n\nDYN_2");
    const cc = dynBlock && "cache_control" in dynBlock ? dynBlock.cache_control : undefined;
    expect(cc).toMatchObject({ type: "ephemeral", ttl: "1h" });
    expect(cc && "scope" in cc).toBe(false);
  });

  test("untagged layers default to static bucket (safe fallback)", () => {
    const result = composeAnthropicMessages(harness({ systemBlocks: [{ text: "UNTAGGED" }] }), [
      { role: "user", content: [{ type: "text", text: "x" }] },
    ]);
    const system = result.find((m) => m.role === "system");
    const block = system?.content.find((b) => b.type === "text" && b.text.includes("UNTAGGED"));
    const cc = block && "cache_control" in block ? block.cache_control : undefined;
    expect(cc).toMatchObject({ type: "ephemeral", ttl: "1h", scope: "global" });
  });

  test("empty systemBlocks emit zero harness blocks (preamble only)", () => {
    const result = composeAnthropicMessages(harness({ systemBlocks: [] }), [
      { role: "user", content: [{ type: "text", text: "x" }] },
    ]);
    const system = result.find((m) => m.role === "system");
    expect(system?.content.length).toBe(2);
  });
});

describe("applyTrailingCacheControl", () => {
  test("adds cache control to the last content block of the last user message", () => {
    const input: Message[] = [
      { role: "user", content: [{ type: "text", text: "hello" }] },
      { role: "assistant", content: [{ type: "text", text: "hi" }] },
      { role: "user", content: [{ type: "text", text: "turn 2" }] },
    ];
    const result = applyTrailingCacheControl(input);
    expect(result.length).toBe(3);
    expect(result[0]).toEqual(input[0]);
    expect(result[1]).toEqual(input[1]);
    const lastMsg = result[2];
    expect(lastMsg).toBeDefined();
    expect(lastMsg!.role).toBe("user");
    expect(lastMsg!.content[0]).toMatchObject({
      type: "text",
      text: "turn 2",
      cache_control: { type: "ephemeral", ttl: "1h" },
    });
  });

  test("does not modify if last message is not a user message", () => {
    const input: Message[] = [
      { role: "user", content: [{ type: "text", text: "hello" }] },
      { role: "assistant", content: [{ type: "text", text: "hi" }] },
    ];
    const result = applyTrailingCacheControl(input);
    expect(result).toEqual(input);
  });

  test("does not crash on empty messages array", () => {
    const result = applyTrailingCacheControl([]);
    expect(result).toEqual([]);
  });
});

describe("composeAnthropicMessages — local command wire layout blocks", () => {
  test("asserts that 3 command messages + 1 prompt merge into one user message with 4 blocks and cache control only on the last", () => {
    const blockA = "<local-command-caveat>Caveat: ...</local-command-caveat>";
    const blockB =
      "<command-name>/effort</command-name>\n            <command-message>effort</command-message>\n            <command-args>medium</command-args>";
    const blockC = "<local-command-stdout>Set effort level to medium...</local-command-stdout>";
    const prompt = "my user prompt";

    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: blockA }] },
      { role: "user", content: [{ type: "text", text: blockB }] },
      { role: "user", content: [{ type: "text", text: blockC }] },
      { role: "user", content: [{ type: "text", text: prompt }] },
    ];

    const sanitized = sanitizeMessages(messages);
    const result = composeAnthropicMessages(harness({ userPrepend: [] }), sanitized);

    const userMessage = result.find((m) => m.role === "user");
    expect(userMessage).toBeDefined();
    expect(userMessage?.content).toHaveLength(4);

    expect(userMessage?.content[0]).toEqual({ type: "text", text: blockA });
    expect(userMessage?.content[1]).toEqual({ type: "text", text: blockB });
    expect(userMessage?.content[2]).toEqual({ type: "text", text: blockC });
    expect(userMessage?.content[3]).toEqual({
      type: "text",
      text: prompt,
      cache_control: { type: "ephemeral", ttl: "1h" },
    });
  });
});

describe("composeAnthropicMessages — cc_prev_req billing chain", () => {
  function billingBlockText(messages: Message[]): string {
    const out = composeAnthropicMessages(harness(), sanitizeMessages(messages));
    const system = out.find((m) => m.role === "system");
    const block = system?.content[0];
    return block?.type === "text" ? block.text : "";
  }

  test("no cc_prev_req before any assistant reply", () => {
    const billing = billingBlockText([{ role: "user", content: [{ type: "text", text: "hi" }] }]);
    expect(billing).not.toContain("cc_prev_req");
  });

  test("cc_prev_req carries the last assistant request-id", () => {
    const billing = billingBlockText([
      { role: "user", content: [{ type: "text", text: "hi" }] },
      {
        role: "assistant",
        requestId: "req_011CceFg6SjrwZ8jcYi97EmG",
        content: [{ type: "text", text: "hello" }],
      },
      { role: "user", content: [{ type: "text", text: "again" }] },
    ]);
    expect(billing.endsWith("cc_prev_req=req_011CceFg6SjrwZ8jcYi97EmG;")).toBe(true);
  });
});
