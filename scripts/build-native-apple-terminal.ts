import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

// The Apple_Terminal Shift+Return probe is built and loaded only on macOS.
if (process.platform !== "darwin") {
  console.log("apple-terminal modifiers add-on: not needed outside macOS");
  process.exit(0);
}

const arch = process.argv[2] ?? process.arch;
if (arch !== "arm64" && arch !== "x64") {
  console.error("apple-terminal modifiers add-on: expected architecture arm64 or x64");
  process.exit(1);
}
const target = arch === "arm64" ? "arm64-apple-darwin" : "x86_64-apple-darwin";
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
    target,
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
