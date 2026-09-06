import { listWorkspaceFiles } from "@/engine/background/subagents/worktree-git.ts";
import { agentRowsFromRegistry } from "@/engine/tools/dynamic/agent-roster.ts";
import {
  agentMentionCandidate,
  fileMentionCandidates,
  type MentionCandidate,
} from "@/ui/input/mention-completion.ts";

export interface MentionSources {
  loadFiles(): Promise<MentionCandidate[]>;
  listAgents(): MentionCandidate[];
}

export const mentionSources: MentionSources = {
  async loadFiles() {
    return fileMentionCandidates(await listWorkspaceFiles(process.cwd()));
  },
  listAgents() {
    return agentRowsFromRegistry().map((agent) =>
      agentMentionCandidate({ id: agent.agentType, description: agent.whenToUse }),
    );
  },
};
