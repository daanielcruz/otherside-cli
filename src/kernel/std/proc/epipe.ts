// A broken downstream pipe (e.g. `cli -p | head -1`) raises EPIPE on every
// later write; without a handler the error is uncaught and the dead stream
// keeps buffering writes until exit. Destroying it drops the buffer and turns
// further writes into no-ops.
export function installEpipeGuard(
  streams: NodeJS.WriteStream[] = [process.stdout, process.stderr],
): void {
  for (const stream of streams) {
    stream.on("error", (err: NodeJS.ErrnoException) => {
      if (err?.code === "EPIPE") stream.destroy();
    });
  }
}
