type ShutdownHandler = () => void | Promise<void>;

const shutdownHandlers = new Set<ShutdownHandler>();
let signalHandlersInstalled = false;
let shuttingDown = false;

export function installProcessSignalHandlers(handler?: ShutdownHandler): void {
  if (handler) shutdownHandlers.add(handler);
  if (signalHandlersInstalled) return;
  signalHandlersInstalled = true;
  process.once("SIGINT", () => {
    void shutdown();
  });
  process.once("SIGTERM", () => {
    void shutdown();
  });
}

export async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  await Promise.allSettled([...shutdownHandlers].map((handler) => Promise.resolve().then(handler)));
}
