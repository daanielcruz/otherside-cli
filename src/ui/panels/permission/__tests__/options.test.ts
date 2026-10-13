import { describe, expect, it } from "bun:test";
import { homedir } from "node:os";
import type { PermissionUpdate } from "@/kernel/permissions/types.ts";
import { buildGenericOptions, type PermissionOptionsInput, resultFor } from "../options.ts";

const CWD = "/work/project";

const readGrant: PermissionUpdate[] = [
  {
    type: "addRules",
    destination: "localSettings",
    rules: [
      {
        source: "localSettings",
        ruleBehavior: "allow",
        ruleValue: { toolName: "Read", ruleContent: "//work/notes/**" },
      },
    ],
  },
];

/** A frame wide enough that no grant label is shortened. */
const ROOMY = 200;

function optionsFor(pending: PermissionOptionsInput["pending"], grantLabelWidth = ROOMY) {
  return buildGenericOptions({
    pending: { cwd: CWD, ...pending },
    isDesign: false,
    mcp: null,
    grantLabelWidth,
  });
}

function labels(pending: PermissionOptionsInput["pending"]): string[] {
  return optionsFor(pending).map((option) => `${option.kind}: ${option.label}`);
}

/** The label with its bold runs marked, so emphasis is checked alongside the words. */
function marked(pending: PermissionOptionsInput["pending"], index: number): string {
  const option = optionsFor(pending)[index];
  return (option?.segments ?? [{ text: option?.label ?? "" }])
    .map((segment) => ("bold" in segment ? `*${segment.text}*` : segment.text))
    .join("");
}

describe("permission options", () => {
  it("names the full directory a command's read grant opens for the project", () => {
    const pending = {
      toolName: "Bash",
      rule: null,
      readOnly: true,
      readDirectories: ["/work/notes"],
    };
    expect(labels(pending)).toEqual([
      "allow: Yes",
      "allow_always: Yes, allow reading from /work/notes from this project",
      "deny: No",
    ]);
    expect(marked(pending, 1)).toBe("Yes, allow reading from */work/notes* from this project");
    expect(resultFor("allow_always", null, "Bash", "", undefined, readGrant)).toEqual({
      decision: "allow",
      updates: readGrant,
    });
  });

  it("offers the directory a command writes into, not a command rule", () => {
    const pending = { toolName: "Bash", rule: null, writeDirectories: [CWD] };
    expect(labels(pending)).toEqual([
      "allow: Yes",
      `allow_always: Yes, and always allow access to ${CWD} from this project`,
      "deny: No",
    ]);
    expect(marked(pending, 1)).toBe(`Yes, and always allow access to *${CWD}* from this project`);
  });

  it("names every command a compound approval saves, in the working directory", () => {
    const pending = {
      toolName: "Bash",
      rule: null,
      rules: ["Bash(make --version)", "Bash(cmake --version)", "Bash(cargo build *)"],
    };
    expect(marked(pending, 1)).toBe(
      `Yes, and don't ask again for *make --version*, *cmake --version*, and *cargo build* commands in *${CWD}*`,
    );
    expect(
      resultFor("allow_always", null, "Bash", "", undefined, undefined, pending.rules),
    ).toEqual({
      decision: "allow",
      updates: [
        {
          type: "addRules",
          destination: "localSettings",
          rules: pending.rules.map((rule) => ({
            source: "localSettings",
            ruleBehavior: "allow",
            ruleValue: {
              toolName: "Bash",
              ruleContent: rule.slice("Bash(".length, -1),
            },
          })),
        },
      ],
    });
  });

  it("names a directory and a command together when one approval saves both", () => {
    expect(
      marked(
        { toolName: "Bash", rule: null, rules: ["Bash(make check *)"], writeDirectories: [CWD] },
        1,
      ),
    ).toBe(`Yes, and allow access to *${CWD}* and *make check* commands`);
  });

  it("offers a read outside the workspace for the session only, with its full directory", () => {
    expect(
      labels({ toolName: "Read", rule: null, readOnly: true, readDirectories: ["/work/notes"] }),
    ).toEqual([
      "allow: Yes",
      "allow_session: Yes, allow reading from /work/notes during this session",
      "deny: No",
    ]);
  });

  it("offers accept-edits mode for an edit inside the workspace", () => {
    for (const toolName of ["Write", "Edit"]) {
      const pending = { toolName, rule: `${toolName}(//work/project/a.txt)` };
      expect(labels(pending)).toEqual([
        "allow: Yes",
        "allow_session_edits: Yes, and switch to accept edits (auto-approve file edits and common file commands) for this session (shift+tab)",
        "deny: No",
      ]);
      expect(marked(pending, 1)).toBe(
        "Yes, and switch to *accept edits (auto-approve file edits and common file commands)* for this session *(shift+tab)*",
      );
    }
  });

  it("names the host a fetch approval saves", () => {
    const pending = { toolName: "WebFetch", rule: "WebFetch(domain:example.com)" };
    expect(labels(pending)).toEqual([
      "allow: Yes",
      "allow_always: Yes, and don't ask again for example.com",
      "deny: No, and tell Otherside what to do differently (esc)",
    ]);
    expect(marked(pending, 1)).toBe("Yes, and don't ask again for *example.com*");
    expect(marked(pending, 2)).toBe("No, and tell Otherside what to do differently *(esc)*");
  });

  it("names a whole-tool approval by the tool's display name in the working directory", () => {
    expect(labels({ toolName: "WebSearch", rule: "WebSearch" })).toEqual([
      "allow: Yes",
      `allow_always: Yes, and don't ask again for Web Search commands in ${CWD}`,
      "deny: No",
    ]);
    expect(labels({ toolName: "Skill", rule: "Skill(release)" })[1]).toBe(
      "allow_always: Yes, and don't ask again for Skill(release) in this project",
    );
  });

  it("fits a whole-tool approval to its row: home as ~, then cut short, else not offered", () => {
    const home = homedir();
    const search = (cwd: string, width: number) =>
      optionsFor({ toolName: "WebSearch", rule: "WebSearch", cwd }, width).map(
        (option) => option.label,
      )[1];
    const lead = "Yes, and don't ask again for Web Search commands in ";

    expect(search(`${home}/placeholder/project`, lead.length + 22)).toBe(
      `${lead}~/placeholder/project`,
    );
    expect(search("/work/a-long-placeholder-project", lead.length + 10)).toBe(`${lead}/work/a-l…`);
    expect(search("/work/project", 0)).toBe("No");
  });
});
