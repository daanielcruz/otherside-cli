import { lastGrapheme } from "@/kernel/std/intl.ts";

let preStartInputQueue = "";

let inputLatchActive = false;

let stdinReadHandler: (() => void) | null = null;

export function activateInputLatch(): void {
  if (
    !process.stdin.isTTY ||
    inputLatchActive ||
    process.argv.includes("-p") ||
    process.argv.includes("--print")
  ) {
    return;
  }

  inputLatchActive = true;
  preStartInputQueue = "";

  try {
    process.stdin.setEncoding("utf8");
    process.stdin.setRawMode(true);
    process.stdin.ref();

    stdinReadHandler = () => {
      let chunk = process.stdin.read();
      while (chunk !== null) {
        if (typeof chunk === "string") {
          parseInputChunk(chunk);
        }
        chunk = process.stdin.read();
      }
    };

    process.stdin.on("readable", stdinReadHandler);
  } catch {
    inputLatchActive = false;
  }
}

function parseInputChunk(str: string): void {
  let i = 0;
  while (i < str.length) {
    const char = str[i]!;
    const code = char.charCodeAt(0);

    if (code === 3) {
      deactivateInputLatch();

      process.exit(130);
      return;
    }

    if (code === 4) {
      deactivateInputLatch();
      return;
    }

    if (code === 127 || code === 8) {
      if (preStartInputQueue.length > 0) {
        const last = lastGrapheme(preStartInputQueue);
        preStartInputQueue = preStartInputQueue.slice(0, -(last.length || 1));
      }
      i++;
      continue;
    }

    if (code === 27) {
      i++;

      while (i < str.length && !(str.charCodeAt(i) >= 64 && str.charCodeAt(i) <= 126)) {
        i++;
      }
      if (i < str.length) i++;
      continue;
    }

    if (code < 32 && code !== 9 && code !== 10 && code !== 13) {
      i++;
      continue;
    }

    if (code === 13) {
      preStartInputQueue += "\n";
      i++;
      continue;
    }

    preStartInputQueue += char;
    i++;
  }
}

export function deactivateInputLatch(): void {
  if (!inputLatchActive) {
    return;
  }

  inputLatchActive = false;

  if (stdinReadHandler) {
    process.stdin.removeListener("readable", stdinReadHandler);
    stdinReadHandler = null;
  }
}

export function drainPreStartInput(): string {
  deactivateInputLatch();
  const input = preStartInputQueue.trim();
  preStartInputQueue = "";
  return input;
}

export function hasPreStartInput(): boolean {
  return preStartInputQueue.trim().length > 0;
}

export function seedPreStartInput(text: string): void {
  preStartInputQueue = text;
}

export function isInputLatchActive(): boolean {
  return inputLatchActive;
}
