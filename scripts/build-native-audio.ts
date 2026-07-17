import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

const root = join(import.meta.dir, "..");
const manifest = join(root, "native", "audio-capture", "Cargo.toml");
const target = process.argv[2]?.trim();
const command = ["cargo", "build", "--manifest-path", manifest, "--release", "--locked"];
if (target) command.push("--target", target);
const result = Bun.spawnSync(command, { cwd: root, stdout: "inherit", stderr: "inherit" });
if (result.exitCode !== 0) process.exit(result.exitCode);
const platform = target?.includes("windows")
  ? "windows"
  : target?.includes("linux")
    ? "linux"
    : process.platform === "win32"
      ? "windows"
      : process.platform;
const filename = platform === "windows"
  ? "otherside_audio_capture.dll"
  : platform === "linux"
    ? "libotherside_audio_capture.so"
    : "libotherside_audio_capture.dylib";
const source = join(root, "native", "audio-capture", "target", ...(target ? [target] : []), "release", filename);
const destination = join(root, "src", "engine", "voice", "native", "audio-capture.node");
mkdirSync(dirname(destination), { recursive: true });
copyFileSync(source, destination);
