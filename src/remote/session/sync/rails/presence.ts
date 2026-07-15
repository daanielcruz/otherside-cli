import type { BroadcastFrame } from "@/remote/_infra/realtime.ts";
import { buildEncryptedEnvBroadcast, type EnvBroadcastDeps } from "./broadcast.ts";

const ENC = new TextEncoder();

export function buildPresenceBroadcast(
  deps: EnvBroadcastDeps & { kind: "cli" | "app"; online: boolean },
): BroadcastFrame {
  const plaintext = ENC.encode(JSON.stringify({ kind: deps.kind, online: deps.online }));
  return buildEncryptedEnvBroadcast("presence", plaintext, deps);
}
