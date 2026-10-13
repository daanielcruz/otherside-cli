export interface RelayNotice {
  /** Report a failure once; the same message is not repeated until the relay settles. */
  report(message: string): void;
  /** Mark the relay healthy so the next failure is reported again. */
  settle(): void;
}

export function createRelayNotice(
  write: (line: string) => void = (line) => {
    process.stderr.write(line);
  },
): RelayNotice {
  let last: string | null = null;
  return {
    report(message) {
      if (message === last) return;
      last = message;
      write(`design relay: ${message}\n`);
    },
    settle() {
      last = null;
    },
  };
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
