// UNC-style paths (\\host\share or //host/share) make the first filesystem
// touch (even existsSync/stat) open an SMB connection to an arbitrary host —
// on Windows that leaks NTLM credentials to the target. Reject before any
// fs call.
export function isNetworkSharePath(filePath: string): boolean {
  return filePath.startsWith("\\\\") || filePath.startsWith("//");
}

export const NETWORK_SHARE_PATH_ERROR = "network share paths (UNC) are not supported";
