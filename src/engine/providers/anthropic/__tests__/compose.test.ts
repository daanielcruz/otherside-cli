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
    midSystemPromotion: "off",
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

describe("composeAnthropicMessages — userPrepend bundle envelope", () => {
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

describe("composeAnthropicMessages — mid-system reminder promotion", () => {
  const MID_BLOCKS = [
    { text: "deferred listing body" },
    { text: "agent listing body" },
    { text: "skills listing body" },
  ];

  test("harness reminders travel as ONE concatenated system message after the first user", () => {
    const result = composeAnthropicMessages(
      harness({ midSystemBlocks: MID_BLOCKS, midSystemPromotion: "unwrapped" }),
      [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    );
    expect(result.map((m) => m.role)).toEqual(["system", "user", "system"]);
    const mid = result[2]!;
    expect(mid.content).toHaveLength(1);
    const block = mid.content[0]!;
    expect(block.type === "text" && block.text).toBe(
      "deferred listing body\n\nagent listing body\n\nskills listing body",
    );
  });

  test("the trailing 1h breakpoint lands on the promoted system message when it closes the request", () => {
    const result = composeAnthropicMessages(
      harness({ midSystemBlocks: MID_BLOCKS, midSystemPromotion: "unwrapped" }),
      [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    );
    const mid = result[result.length - 1]!;
    const block = mid.content[mid.content.length - 1];
    expect(block?.type === "text" && block.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
  });

  test("a text-only reminder after a user promotes in place, keeping the wrapper on the wrapped route", () => {
    const steer: Message = {
      role: "user",
      content: [
        {
          type: "text",
          text: "<system-reminder>\nqueued guidance\n</system-reminder>",
          reminder_type: "queued_input",
        },
        { type: "text", text: "follow-up input" },
      ],
    };
    const history: Message[] = [
      { role: "user", content: [{ type: "text", text: "hello" }] },
      steer,
    ];
    const wrapped = composeAnthropicMessages(harness({ midSystemPromotion: "wrapped" }), history);
    expect(wrapped.map((m) => m.role)).toEqual(["system", "user", "system"]);
    const promoted = wrapped[2]!.content[0]!;
    expect(promoted.type === "text" && promoted.text).toBe(
      "<system-reminder>\nqueued guidance\n</system-reminder>\n\nfollow-up input",
    );

    const unwrapped = composeAnthropicMessages(
      harness({ midSystemPromotion: "unwrapped" }),
      history,
    );
    const bare = unwrapped[2]!.content[0]!;
    expect(bare.type === "text" && bare.text).toBe("queued guidance\n\nfollow-up input");
  });

  test("a reminder after a plain assistant remains a user message", () => {
    const reminder: Message = {
      role: "user",
      content: [
        {
          type: "text",
          text: "<system-reminder>\nqueued guidance\n</system-reminder>",
          reminder_type: "queued_input",
        },
      ],
    };
    const result = composeAnthropicMessages(harness({ midSystemPromotion: "unwrapped" }), [
      { role: "user", content: [{ type: "text", text: "hello" }] },
      { role: "assistant", content: [{ type: "text", text: "working" }] },
      reminder,
    ]);

    expect(result.map((m) => m.role)).toEqual(["system", "user", "assistant", "user"]);
    expect(result[3]?.content).toEqual([
      {
        type: "text",
        text: "<system-reminder>\nqueued guidance\n</system-reminder>",
        cache_control: { type: "ephemeral", ttl: "1h" },
      },
    ]);
  });

  test("a reminder after an assistant ending in a server tool result promotes", () => {
    const serverToolResult = {
      type: "web_search_tool_result",
      content: [],
    } as unknown as Message["content"][number];
    const result = composeAnthropicMessages(harness({ midSystemPromotion: "unwrapped" }), [
      { role: "user", content: [{ type: "text", text: "hello" }] },
      { role: "assistant", content: [{ type: "text", text: "searching" }, serverToolResult] },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "<system-reminder>\nqueued guidance\n</system-reminder>",
            reminder_type: "queued_input",
          },
        ],
      },
    ]);

    expect(result.map((m) => m.role)).toEqual(["system", "user", "assistant", "system"]);
    expect(result[3]?.content).toMatchObject([{ type: "text", text: "queued guidance" }]);
  });

  test("multiple reminders in one qualifying turn become one system message", () => {
    const result = composeAnthropicMessages(harness({ midSystemPromotion: "unwrapped" }), [
      { role: "user", content: [{ type: "text", text: "hello" }] },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "<system-reminder>\nfirst reminder\n</system-reminder>",
            reminder_type: "queued_input",
          },
          {
            type: "text",
            text: "<system-reminder>\nsecond reminder\n</system-reminder>",
            reminder_type: "task_reminder",
          },
        ],
      },
    ]);

    expect(result.map((m) => m.role)).toEqual(["system", "user", "system"]);
    expect(result[2]?.content).toMatchObject([
      { type: "text", text: "first reminder\n\nsecond reminder" },
    ]);
  });

  test("adjacent reminder messages do not create consecutive system messages", () => {
    function reminder(text: string): Message {
      return {
        role: "user",
        content: [
          {
            type: "text",
            text: `<system-reminder>\n${text}\n</system-reminder>`,
            reminder_type: "queued_input",
          },
        ],
      };
    }

    const result = composeAnthropicMessages(harness({ midSystemPromotion: "unwrapped" }), [
      { role: "user", content: [{ type: "text", text: "hello" }] },
      reminder("first reminder"),
      reminder("second reminder"),
    ]);

    expect(result.map((m) => m.role)).toEqual(["system", "user", "system", "user"]);
    expect(result[2]?.content).toMatchObject([{ type: "text", text: "first reminder" }]);
    expect(result[3]?.content).toMatchObject([
      { type: "text", text: "<system-reminder>\nsecond reminder\n</system-reminder>" },
    ]);
  });

  test("a first-turn promoted system message blocks a later reminder promotion", () => {
    const result = composeAnthropicMessages(
      harness({
        midSystemPromotion: "unwrapped",
        midSystemBlocks: [{ text: "first-turn reminder" }],
      }),
      [
        { role: "user", content: [{ type: "text", text: "hello" }] },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "<system-reminder>\nlater reminder\n</system-reminder>",
              reminder_type: "queued_input",
            },
          ],
        },
      ],
    );

    expect(result.map((m) => m.role)).toEqual(["system", "user", "system", "user"]);
  });

  test("reminder messages stay user turns when promotion is off or content is not text-only", () => {
    const withImage: Message = {
      role: "user",
      content: [
        {
          type: "text",
          text: "<system-reminder>\nnote\n</system-reminder>",
          reminder_type: "queued_input",
        },
        {
          type: "image",
          source: { type: "base64", media_type: "image/png", data: "aGk=" },
        },
      ],
    };
    const offResult = composeAnthropicMessages(harness({ midSystemPromotion: "off" }), [
      { role: "user", content: [{ type: "text", text: "hello" }] },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "<system-reminder>\nnote\n</system-reminder>",
            reminder_type: "queued_input",
          },
        ],
      },
    ]);
    expect(offResult.filter((m) => m.role === "system")).toHaveLength(1);

    const mixedResult = composeAnthropicMessages(harness({ midSystemPromotion: "wrapped" }), [
      { role: "user", content: [{ type: "text", text: "hello" }] },
      withImage,
    ]);
    expect(mixedResult.filter((m) => m.role === "system")).toHaveLength(1);
  });
});
