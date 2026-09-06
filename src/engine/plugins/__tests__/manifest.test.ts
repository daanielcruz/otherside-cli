import { describe, expect, test } from "bun:test";
import { parseManifest } from "../manifest.ts";

describe("parseManifest", () => {
  test("valid minimal manifest with only name", () => {
    const result = parseManifest({ name: "my-plugin" });
    expect(result).toEqual({ name: "my-plugin" });
  });

  test("full manifest with all fields", () => {
    const raw = {
      name: "full-plugin",
      version: "1.2.0",
      description: "A fully-specified plugin manifest",
      author: { name: "Jane Doe", email: "jane@example.com", url: "https://example.com" },
      commands: {
        lint: {
          source: "commands/lint.md",
          description: "Run linter",
          argumentHint: "<file>",
          model: "sonnet",
          allowedTools: ["Bash", "Read"],
        },
      },
      agents: ["agents/reviewer.md"],
      skills: ["skills/deploy.md"],
      hooks: {
        preToolUse: [{ matcher: "Bash", command: "echo pre", timeout: 5 }],
        stop: [{ type: "prompt" as const, matcher: ".*", prompt: "summarize" }],
      },
      mcpServers: {
        myServer: {
          command: "node",
          args: ["server.js"],
          env: { TOKEN: "abc" },
          cwd: "/tmp",
        },
      },
      lspServers: {
        myLanguage: {
          command: "language-server",
          args: ["--stdio"],
          env: { TOKEN: "abc" },
          cwd: "server",
          extensionToLanguage: { ".demo": "demo" },
        },
      },
      dependencies: ["other-plugin"],
    };

    const result = parseManifest(raw);
    expect(result.name).toBe("full-plugin");
    expect(result.version).toBe("1.2.0");
    expect(result.description).toBe("A fully-specified plugin manifest");
    expect(result.author).toEqual({
      name: "Jane Doe",
      email: "jane@example.com",
      url: "https://example.com",
    });
    expect(result.commands).toEqual(raw.commands);
    expect(result.agents).toEqual(["agents/reviewer.md"]);
    expect(result.skills).toEqual(["skills/deploy.md"]);
    expect(result.hooks).toEqual(raw.hooks);
    expect(result.mcpServers).toEqual(raw.mcpServers);
    expect(result.lspServers).toEqual(raw.lspServers);
    expect(result.dependencies).toEqual(["other-plugin"]);
  });

  test("throws when name is missing", () => {
    expect(() => parseManifest({})).toThrow();
  });

  test("throws when name contains spaces", () => {
    expect(() => parseManifest({ name: "my plugin" })).toThrow(/kebab-case/);
  });

  describe("commands accepts multiple shapes", () => {
    test("commands as a string", () => {
      const result = parseManifest({ name: "cmd-str", commands: "commands/" });
      expect(result.commands).toBe("commands/");
    });

    test("commands as an array of strings", () => {
      const result = parseManifest({
        name: "cmd-arr",
        commands: ["commands/lint.md", "commands/fmt.md"],
      });
      expect(result.commands).toEqual(["commands/lint.md", "commands/fmt.md"]);
    });

    test("commands as an object with metadata", () => {
      const result = parseManifest({
        name: "cmd-obj",
        commands: {
          lint: { description: "Run linter", source: "commands/lint.md" },
        },
      });
      expect(result.commands).toEqual({
        lint: { description: "Run linter", source: "commands/lint.md" },
      });
    });
  });

  describe("mcpServers accepts file, record, and array forms", () => {
    test("accepts ordered file and inline entries", () => {
      const result = parseManifest({
        name: "mcp-array",
        mcpServers: [
          "./servers.json",
          { events: { type: "sse", url: "https://example.com/events" } },
        ],
      });
      expect(result.mcpServers).toEqual([
        "./servers.json",
        { events: { type: "sse", url: "https://example.com/events" } },
      ]);
    });

    test("rejects ambiguous transport definitions", () => {
      expect(() =>
        parseManifest({
          name: "mcp-invalid",
          mcpServers: { bad: { command: "node", url: "https://example.com/mcp" } },
        }),
      ).toThrow(/exactly one transport/);
      expect(() =>
        parseManifest({
          name: "mcp-typed-invalid",
          mcpServers: {
            bad: { type: "http", command: "node", url: "https://example.com/mcp" },
          },
        }),
      ).toThrow(/exactly one transport/);
    });
  });

  describe("hooks accepts inline config or path string", () => {
    test("hooks as an inline object", () => {
      const hooks = {
        postToolUse: [{ matcher: "Write", command: "echo done" }],
      };
      const result = parseManifest({ name: "hook-obj", hooks });
      expect(result.hooks).toEqual(hooks);
    });

    test("hooks as a path string", () => {
      const result = parseManifest({ name: "hook-str", hooks: "hooks.json" });
      expect(result.hooks).toBe("hooks.json");
    });
  });
});
