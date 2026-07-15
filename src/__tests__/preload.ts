import { afterAll, beforeEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const originalConfigDir = process.env.OTHERSIDE_CONFIG_DIR;
const originalEphemeralSessionsDir = process.env.OTHERSIDE_EPHEMERAL_SESSIONS_DIR;
const scratchRoot = mkdtempSync(join(tmpdir(), "otherside-test-scratch-"));
const configDir = join(scratchRoot, "config");
const ephemeralSessionsDir = join(scratchRoot, "sessions");

mkdirSync(configDir, { recursive: true });
mkdirSync(ephemeralSessionsDir, { recursive: true });

function applySuiteIsolation(): void {
  process.env.OTHERSIDE_CONFIG_DIR = configDir;
  process.env.OTHERSIDE_EPHEMERAL_SESSIONS_DIR = ephemeralSessionsDir;
}

function restoreSuiteIsolation(): void {
  const currentConfigDir = process.env.OTHERSIDE_CONFIG_DIR;
  if (currentConfigDir === undefined || currentConfigDir === originalConfigDir) {
    process.env.OTHERSIDE_CONFIG_DIR = configDir;
  }

  const currentEphemeralSessionsDir = process.env.OTHERSIDE_EPHEMERAL_SESSIONS_DIR;
  if (
    currentEphemeralSessionsDir === undefined ||
    currentEphemeralSessionsDir === originalEphemeralSessionsDir
  ) {
    process.env.OTHERSIDE_EPHEMERAL_SESSIONS_DIR = ephemeralSessionsDir;
  }
}

applySuiteIsolation();
beforeEach(restoreSuiteIsolation);

afterAll(() => {
  if (originalConfigDir === undefined) delete process.env.OTHERSIDE_CONFIG_DIR;
  else process.env.OTHERSIDE_CONFIG_DIR = originalConfigDir;

  if (originalEphemeralSessionsDir === undefined) {
    delete process.env.OTHERSIDE_EPHEMERAL_SESSIONS_DIR;
  } else {
    process.env.OTHERSIDE_EPHEMERAL_SESSIONS_DIR = originalEphemeralSessionsDir;
  }

  rmSync(scratchRoot, { recursive: true, force: true });
});
