import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withFileLock } from "@/kernel/std/fs/file-lock.ts";

test("keeps a live process lock beyond the stale-file window", async () => {
  const home = mkdtempSync(join(tmpdir(), "otherside-file-lock-test-"));
  const target = join(home, "state.json");
  const order: string[] = [];
  let releaseFirst: () => void = () => {};
  let firstEntered: () => void = () => {};
  const holdFirst = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    firstEntered = resolve;
  });

  try {
    const first = withFileLock(
      target,
      async () => {
        order.push("first:start");
        firstEntered();
        await holdFirst;
        order.push("first:end");
      },
      { staleAfterMs: 50, updateMs: 5 },
    );
    await entered;

    const second = withFileLock(
      target,
      () => {
        order.push("second");
      },
      { retryMs: 1, maxWaitMs: 500, staleAfterMs: 50, updateMs: 5 },
    );
    await Bun.sleep(80);

    expect(order).toEqual(["first:start"]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(["first:start", "first:end", "second"]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("reports a compromised lease without deleting its replacement", async () => {
  const home = mkdtempSync(join(tmpdir(), "otherside-file-lock-test-"));
  const target = join(home, "state.json");
  const path = `${target}.lock`;
  let release: () => void = () => {};
  let entered: () => void = () => {};
  let compromised: () => void = () => {};
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const active = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const detected = new Promise<void>((resolve) => {
    compromised = resolve;
  });

  try {
    const locked = withFileLock(
      target,
      async () => {
        entered();
        await hold;
      },
      {
        onCompromised: compromised,
        staleAfterMs: 20,
        updateMs: 1,
      },
    );
    await active;
    unlinkSync(path);
    writeFileSync(path, JSON.stringify({ owner: "replacement", pid: process.pid }));

    await detected;
    release();
    await locked;

    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      owner: "replacement",
      pid: process.pid,
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
