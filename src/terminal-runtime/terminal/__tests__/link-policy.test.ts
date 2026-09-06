import { afterAll, describe, expect, it, mock } from "bun:test";
import type { AttacherCaps } from "@/terminal-runtime/host/environment.ts";

const environmentModule = await import("@/terminal-runtime/host/environment.js");
const hyperlinkPackage = await import("supports-hyperlinks");
let attacherCapabilities: AttacherCaps | null = null;
let packageDetectorResult = false;
mock.module("@/terminal-runtime/host/environment.js", () => ({
  ...environmentModule,
  readAttacherCapabilities: () => attacherCapabilities,
}));
mock.module("supports-hyperlinks", () => ({
  ...hyperlinkPackage,
  createSupportsHyperlinks: () => packageDetectorResult,
}));

afterAll(() => {
  mock.module("@/terminal-runtime/host/environment.js", () => environmentModule);
  mock.module("supports-hyperlinks", () => hyperlinkPackage);
});

const { evaluateLinkSupport } = await import("@/terminal-runtime/terminal/link-policy.ts");

type Env = Record<string, string | undefined>;
type Options = { env?: Env; libraryDecision?: boolean };

const PRODUCT_TERMINALS = [
  "ghostty",
  "Hyper",
  "kitty",
  "alacritty",
  "iTerm.app",
  "iTerm2",
  "WezTerm",
  "vscode",
] as const;

function expectedPolicyDecision(options?: Options): boolean {
  const env = options?.env ?? process.env;
  const remoteDecision = attacherCapabilities?.hyperlinks;
  if (remoteDecision !== undefined) return remoteDecision;

  const libraryDecision = options?.libraryDecision ?? packageDetectorResult;
  if ("FORCE_HYPERLINK" in env) return libraryDecision;
  if (libraryDecision) return true;

  const termProgram = env.TERM_PROGRAM;
  if (
    termProgram &&
    PRODUCT_TERMINALS.includes(termProgram as (typeof PRODUCT_TERMINALS)[number])
  ) {
    return true;
  }
  if (env.TERMINAL_EMULATOR === "JetBrains-JediTerm") return true;
  if (termProgram === "tmux") {
    const [major, minor] = (env.TERM_PROGRAM_VERSION ?? "").split(".");
    const majorNum = Number.parseInt(major ?? "", 10);
    const minorNum = Number.parseInt(minor ?? "", 10);
    if (majorNum > 3 || (majorNum === 3 && minorNum >= 4)) return true;
  }

  const lcTerminal = env.LC_TERMINAL;
  if (lcTerminal && PRODUCT_TERMINALS.includes(lcTerminal as (typeof PRODUCT_TERMINALS)[number])) {
    return true;
  }
  return env.TERM?.includes("kitty") === true || env.TERM?.includes("ghostty") === true;
}

function check(options?: Options): boolean {
  return evaluateLinkSupport(options);
}

describe("evaluateLinkSupport", () => {
  it("keeps the attacher override above every local signal", () => {
    for (const override of [true, false] as const) {
      attacherCapabilities = { hyperlinks: override };
      expect(
        check({
          env: { FORCE_HYPERLINK: "1", TERM: "xterm-kitty" },
          libraryDecision: true,
        }),
      ).toBe(override);
    }
    attacherCapabilities = null;
  });

  it("preserves the public detector result when FORCE_HYPERLINK is present", () => {
    for (const value of ["", "0", "1", "false", "9"]) {
      for (const libraryDecision of [false, true]) {
        expect(
          check({
            env: { FORCE_HYPERLINK: value, TERM: "xterm-kitty" },
            libraryDecision,
          }),
        ).toBe(libraryDecision);
      }
    }
  });

  it("recognizes product terminal extensions and exact version facts", () => {
    for (const terminal of PRODUCT_TERMINALS) {
      expect(check({ env: { TERM_PROGRAM: terminal }, libraryDecision: false })).toBe(true);
      expect(check({ env: { LC_TERMINAL: terminal }, libraryDecision: false })).toBe(true);
    }
    expect(
      check({
        env: { TERMINAL_EMULATOR: "JetBrains-JediTerm" },
        libraryDecision: false,
      }),
    ).toBe(true);
    expect(check({ env: { TERM: "xterm-kitty" }, libraryDecision: false })).toBe(true);
    expect(check({ env: { TERM: "xterm-ghostty" }, libraryDecision: false })).toBe(true);
  });

  it("requires tmux 3.4 or newer", () => {
    for (const [version, supported] of [
      [undefined, false],
      ["3.3", false],
      ["3.4", true],
      ["3.4.0", true],
      ["4.0", true],
      ["bogus", false],
    ] as const) {
      expect(
        check({
          env: { TERM_PROGRAM: "tmux", TERM_PROGRAM_VERSION: version },
          libraryDecision: false,
        }),
      ).toBe(supported);
    }
  });

  it("matches the policy contract across the capability matrix", () => {
    const environments: Env[] = [
      {},
      { TERM: "dumb" },
      { TERM: "xterm-kitty" },
      { TERM: "xterm-ghostty" },
      { TERM_PROGRAM: "WezTerm", TERM_PROGRAM_VERSION: "20240101" },
      { TERM_PROGRAM: "vscode", TERM_PROGRAM_VERSION: "1.71.0" },
      { TERM_PROGRAM: "tmux", TERM_PROGRAM_VERSION: "3.3" },
      { TERM_PROGRAM: "tmux", TERM_PROGRAM_VERSION: "3.4" },
      { LC_TERMINAL: "iTerm2" },
      { TERMINAL_EMULATOR: "JetBrains-JediTerm" },
      { CI: "1", TERM_PROGRAM: "Hyper" },
      { NETLIFY: "1" },
      { TEAMCITY_VERSION: "2025.1", TERM: "dumb" },
      { VTE_VERSION: "0.50.0", TERM: "dumb" },
    ];
    const forceValues = [undefined, "", "0", "1", "false"] as const;
    const libraryDecisions = [undefined, false, true] as const;

    let comparisons = 0;
    for (const override of [undefined, false, true] as const) {
      attacherCapabilities = override === undefined ? null : { hyperlinks: override };
      for (const baseEnv of environments) {
        for (const forceValue of forceValues) {
          const env = { ...baseEnv };
          if (forceValue !== undefined) env.FORCE_HYPERLINK = forceValue;
          for (const libraryDecision of libraryDecisions) {
            packageDetectorResult = libraryDecision ?? false;
            const options: Options = {
              env,
              ...(libraryDecision !== undefined && { libraryDecision }),
            };
            expect(check(options)).toBe(expectedPolicyDecision(options));
            comparisons++;
          }
        }
      }
    }
    attacherCapabilities = null;
    expect(comparisons).toBe(630);
  });

  it("reads the supplied environment on every call without replacing it", () => {
    const env: Env = { TERM: "dumb" };
    expect(check({ env, libraryDecision: false })).toBe(false);
    env.TERM = "xterm-ghostty";
    expect(check({ env, libraryDecision: false })).toBe(true);
    expect(env).toEqual({ TERM: "xterm-ghostty" });
  });
});
