import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

// Compiles the Apple_Terminal Shift+Return probe into the statically required
// .node artifact. The compiled binary embeds it on every target; only the
// darwin runtime gate ever loads it, so a darwin host is the one requirement.
const root = join(import.meta.dir, "..");
const source = join(root, "src", "platform", "apple-terminal", "modifiers.c");
const destination = join(
  root,
  "src",
  "platform",
  "apple-terminal",
  "native",
  "apple-terminal-modifiers.node",
);

if (process.platform !== "darwin") {
  console.error("apple-terminal modifiers add-on: darwin build host required");
  process.exit(1);
}

mkdirSync(dirname(destination), { recursive: true });
const compile = Bun.spawnSync(
  [
    "clang",
    "-std=c17",
    "-Wall",
    "-Wextra",
    "-Werror",
    "-O2",
    "-fvisibility=hidden",
    "-target",
    "arm64-apple-darwin",
    "-DNAPI_VERSION=8",
    "-I",
    join(root, "vendor", "node-api"),
    "-framework",
    "ApplicationServices",
    "-dynamiclib",
    "-undefined",
    "dynamic_lookup",
    "-o",
    destination,
    source,
  ],
  { cwd: root, stdout: "inherit", stderr: "inherit" },
);
if (compile.exitCode !== 0) process.exit(compile.exitCode);

const sign = Bun.spawnSync(["codesign", "--force", "--sign", "-", destination], {
  cwd: root,
  stdout: "inherit",
  stderr: "inherit",
});
if (sign.exitCode !== 0) process.exit(sign.exitCode);
