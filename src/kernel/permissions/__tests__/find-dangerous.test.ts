import { describe, expect, it } from "bun:test";
import {
  allowRuleCoversDangerousFind,
  stripExecWrappers,
} from "@/kernel/permissions/bash-matcher.ts";

// This gate refuses an allow-rule that would cover a destructive `find`. Every
// dangerous case MUST return true; a leak lets a broad rule persist unsafe finds.
describe("allowRuleCoversDangerousFind", () => {
  const dangerous = [
    "find . -delete",
    "find . -exec rm {} +",
    "find . -fprintf /tmp/x %p", // the newly-covered write flag
    "find . -fls /tmp/x",
    // env-var assignment + safe-wrapper prefixes must not hide the find head
    "DEBUG=1 find . -delete",
    "FOO=1 BAR=2 find . -exec rm {} +",
    "timeout 10 find . -delete",
    "nice find . -delete",
    "DEBUG=1 timeout 5 find . -delete",
    // exec-wrappers (env/sudo/doas/pkexec) must not hide the find head
    "env find . -delete",
    "env X=1 find . -delete",
    "env -i find . -delete",
    "env -u PATH find . -delete",
    "sudo find . -delete",
    "sudo -u root find . -exec rm {} +",
    "sudo -- find . -delete",
    "doas find . -delete",
    "doas -u root find . -delete",
    "pkexec find . -delete",
    "pkexec --user root find . -delete",
    // wrappers stacked with the safe-wrapper / env peel
    "sudo timeout 5 find . -delete",
    "env X=1 sudo find . -delete",
    // a quoted -c body must be re-parsed, not read as opaque tokens
    'sh -c "find . -delete"',
    "bash -c 'find . -exec rm {} +'",
    "bash -lc 'find . -delete'",
    'sh -ec "find . -delete"',
    "sh -c'find . -delete'",
    'bash -c"find . -delete"',
    "bash -o pipefail -c 'find . -delete'",
    "bash -c -- 'find . -delete'",
    "sh -- -c 'find . -delete'",
    'zsh -c "sudo find . -delete"',
    "sudo sh -c 'find . -delete'",
    `sh -c "sh -c 'find . -delete'"`,
  ];
  for (const cmd of dangerous) {
    it(`flags: ${cmd}`, () => expect(allowRuleCoversDangerousFind(cmd)).toBe(true));
  }

  const safe = [
    "find . -name '*.ts'",
    "find src -type f",
    "ls -la",
    "DEBUG=1 find . -name foo", // wrapped but no dangerous flag
    "grep -rn foo",
    "sudo find . -name foo", // wrapped but no dangerous flag
    "sudo apt-get install foo", // wrapper over a non-find command
    "env NODE_ENV=prod node app.js",
    "sh -c 'find . -name foo'", // -c body with a harmless find
    "sh -c'find . -name foo'", // glued -c body with a harmless find
    "bash -o pipefail -c 'find . -name foo'", // -o before a harmless -c body
    "bash -c -- 'find . -name foo'", // -- before a harmless -c body
    "bash -c 'ls -la'", // -c body without find
    "sh script.sh", // positional script, no -c body to inspect
  ];
  for (const cmd of safe) {
    it(`allows: ${cmd}`, () => expect(allowRuleCoversDangerousFind(cmd)).toBe(false));
  }
});

describe("stripExecWrappers", () => {
  it("peels a bare sudo", () => {
    expect(stripExecWrappers(["sudo", "find", ".", "-delete"])).toEqual(["find", ".", "-delete"]);
  });
  it("consumes sudo -u with its argument", () => {
    expect(stripExecWrappers(["sudo", "-u", "root", "find", "."])).toEqual(["find", "."]);
  });
  it("stops option scanning at --", () => {
    expect(stripExecWrappers(["sudo", "--", "find", "."])).toEqual(["find", "."]);
  });
  it("peels env options then NAME=VALUE assignments", () => {
    expect(stripExecWrappers(["env", "-i", "X=1", "find", "."])).toEqual(["find", "."]);
  });
  it("keeps an inline --user=root as one token", () => {
    expect(stripExecWrappers(["pkexec", "--user=root", "find", "."])).toEqual(["find", "."]);
  });
  it("leaves a non-wrapper head untouched", () => {
    expect(stripExecWrappers(["find", ".", "-delete"])).toEqual(["find", ".", "-delete"]);
  });
});
