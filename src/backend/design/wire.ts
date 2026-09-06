import { CortexApiError, cortexFetch } from "@/backend/shared/cortex.ts";

const DESIGN_WEB_ORIGIN_DEFAULT = "https://design.othersidecli.com";

export function designWebUrl(openToken: string, cliPubB64: string): string {
  const origin = (process.env.OTHERSIDE_DESIGN_WEB_ORIGIN ?? DESIGN_WEB_ORIGIN_DEFAULT).replace(
    /\/+$/,
    "",
  );
  return `${origin}/open/${encodeURIComponent(openToken)}#k=${cliPubB64}`;
}

export async function ensureDesignProject(args: {
  accessToken: string;
  userId: string;
  designId: string;
  environmentId: string;
}): Promise<string> {
  const data = await cortexFetch<{ id?: string; design_id?: string }>("/v1/design/projects", {
    method: "POST",
    token: args.accessToken,
    body: {
      design_id: args.designId,
      environment_id: args.environmentId,
    },
    idempotencyKey: crypto.randomUUID(),
  });
  const id = data.id ?? data.design_id;
  if (!id) throw new Error("design_projects upsert returned no id");
  return id;
}

export async function registerDesignSession(args: {
  accessToken: string;
  userId: string;
  environmentId: string;
  sessionHash: string;
  designProjectId: string;
  provider: string;
  model: string;
  permissionMode: string;
}): Promise<{ instanceId: string }> {
  const session = await cortexFetch<{ instance_id: string }>("/v1/sessions", {
    method: "POST",
    token: args.accessToken,
    body: {
      id: args.sessionHash,
      environment_id: args.environmentId,
      provider: args.provider,
      model: args.model,
      permission_mode: args.permissionMode,
      status: "idle",
      design_project_id: args.designProjectId,
    },
    idempotencyKey: crypto.randomUUID(),
  });
  return { instanceId: session.instance_id };
}

export type DesignSessionStatus = "streaming" | "idle" | "awaiting" | "disconnected" | "ended";

export async function readDesignSessionStatus(args: {
  accessToken: string;
  sessionHash: string;
}): Promise<DesignSessionStatus | null> {
  try {
    const session = await cortexFetch<{ status: DesignSessionStatus }>(
      `/v1/sessions/${args.sessionHash}`,
      {
        method: "GET",
        token: args.accessToken,
      },
    );
    return session.status;
  } catch (error) {
    if (error instanceof CortexApiError && error.code === "not_found") return null;
    throw error;
  }
}

export async function patchDesignSession(
  accessToken: string,
  sessionHash: string,
  body: Record<string, unknown>,
): Promise<void> {
  await cortexFetch(`/v1/sessions/${sessionHash}`, {
    method: "PATCH",
    token: accessToken,
    body,
  });
}

export async function patchDesignProject(
  accessToken: string,
  designProjectId: string,
  body: Record<string, unknown>,
): Promise<void> {
  // Cortex upsert is POST /v1/design/projects with design_id
  await cortexFetch("/v1/design/projects", {
    method: "POST",
    token: accessToken,
    body: {
      design_id: designProjectId,
      ...body,
    },
  });
}

export async function endSessionsForDesignProject(
  accessToken: string,
  designProjectId: string,
): Promise<void> {
  // List sessions and end those linked to the design project when present.
  try {
    const sessions = await cortexFetch<
      Array<{ id: string; design_project_id?: string | null; status?: string }>
    >("/v1/sessions", { method: "GET", token: accessToken });
    for (const s of sessions) {
      if (s.design_project_id === designProjectId && s.status !== "ended") {
        await patchDesignSession(accessToken, s.id, { status: "ended" });
      }
    }
  } catch {
    /* best-effort */
  }
}

export async function touchDesignSession(args: {
  accessToken: string;
  sessionHash: string;
}): Promise<void> {
  await patchDesignSession(args.accessToken, args.sessionHash, { status: "idle" });
}

export async function refreshDesignSessionLease(args: {
  accessToken: string;
  sessionHash: string;
}): Promise<"active" | "terminal"> {
  const status = await readDesignSessionStatus(args);
  if (status === null || status === "ended") return "terminal";
  await touchDesignSession(args);
  return "active";
}

export async function patchProjectVersion(args: {
  accessToken: string;
  designProjectId: string;
  version: number;
}): Promise<void> {
  await patchDesignProject(args.accessToken, args.designProjectId, {
    project_version: args.version,
  }).catch(() => {});
}

export async function setDesignSessionStatus(args: {
  accessToken: string;
  sessionHash: string;
  status: "idle" | "disconnected" | "ended";
}): Promise<void> {
  await patchDesignSession(args.accessToken, args.sessionHash, {
    status: args.status,
  }).catch(() => {});
}

export async function endProjectSessions(args: {
  accessToken: string;
  designProjectId: string;
}): Promise<void> {
  await endSessionsForDesignProject(args.accessToken, args.designProjectId);
}
