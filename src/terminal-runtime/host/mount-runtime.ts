import { Stream } from "node:stream";
import type { ReactNode } from "react";
import instances from "@/terminal-runtime/host/runtime-registry.js";
import Ink, { type Options as InkOptions } from "@/terminal-runtime/host/runtime-session.js";
import type { FrameMetrics } from "@/terminal-runtime/paint/frame-state.js";
import { emitDiagnosticOutput } from "@/utils/debug.js";

export type RenderOptions = {
  stdout?: NodeJS.WriteStream;

  stdin?: NodeJS.ReadStream;

  stderr?: NodeJS.WriteStream;

  exitOnCtrlC?: boolean;

  patchConsole?: boolean;

  onFrame?: ((event: FrameMetrics) => void) | undefined;
  nativeCursor?: boolean | undefined;
  isScreenReaderEnabled?: boolean | undefined;
};

export type Instance = {
  rerender: Ink["render"];

  unmount: Ink["unmount"];

  waitUntilExit: Ink["waitUntilExit"];
  cleanup: () => void;
};

export const executeImmediate = (
  node: ReactNode,
  options?: NodeJS.WriteStream | RenderOptions,
): Instance => {
  const opts = normalizeConfig(options);
  const inkOptions: InkOptions = {
    stdout: process.stdout,
    stdin: process.stdin,
    stderr: process.stderr,
    exitOnCtrlC: true,
    patchConsole: true,
    ...opts,
  };

  const instance: Ink = resolveExecutor(inkOptions.stdout, () => new Ink(inkOptions));

  instance.render(node);

  return {
    rerender: instance.render,
    unmount() {
      instance.unmount();
    },
    waitUntilExit: instance.waitUntilExit,
    cleanup: () => instances.delete(inkOptions.stdout),
  };
};

const mountTerminalApp = async (
  node: ReactNode,
  options?: NodeJS.WriteStream | RenderOptions,
): Promise<Instance> => {
  await Promise.resolve();
  const instance = executeImmediate(node, options);
  emitDiagnosticOutput(
    `[render] first ink render: ${Math.round(process.uptime() * 1000)}ms since process start`,
  );
  return instance;
};

export default mountTerminalApp;

const normalizeConfig = (
  stdout: NodeJS.WriteStream | RenderOptions | undefined = {},
): RenderOptions => {
  if (stdout instanceof Stream) {
    return {
      stdout,
      stdin: process.stdin,
    };
  }

  return stdout;
};

const resolveExecutor = (stdout: NodeJS.WriteStream, createInstance: () => Ink): Ink => {
  let instance = instances.get(stdout);

  if (!instance) {
    instance = createInstance();
    instances.set(stdout, instance);
  }

  return instance;
};
