import { isErrno } from "@/kernel/std/errno.ts";

/** Whether a process with this pid exists; one owned by another user counts as alive. */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isErrno(error, "EPERM");
  }
}
