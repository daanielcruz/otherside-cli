import {
  loadConfigSync,
  SKILL_STATES,
  type SkillState,
  updateConfig,
} from "@/kernel/config/config.ts";
import type { Skill } from "./registry.ts";

// Resolution: the stored override wins; an author model-lock (the skill's own
// frontmatter opts out of model invocation) pins the state to
// user-invocable-only unless the user explicitly turned the skill off.
export function skillStateFor(skill: Skill): SkillState {
  const stored = loadConfigSync().skillStates?.[skill.name];
  if (skill.authorModelLock) return stored === "off" ? "off" : "user-invocable-only";
  return stored ?? "on";
}

export function nextSkillState(skill: Skill): SkillState {
  const current = skillStateFor(skill);
  if (skill.authorModelLock) return current === "off" ? "user-invocable-only" : "off";
  return SKILL_STATES[(SKILL_STATES.indexOf(current) + 1) % SKILL_STATES.length]!;
}

export function cycleSkillState(skill: Skill): SkillState {
  return setSkillState(skill, nextSkillState(skill));
}

export function setSkillState(skill: Skill, state: SkillState): SkillState {
  void updateConfig((cfg) => {
    const states = { ...cfg.skillStates };
    // Persist only genuine overrides; a state equal to the natural one is dropped.
    const natural = skill.authorModelLock ? "user-invocable-only" : "on";
    if (state === natural) delete states[skill.name];
    else states[skill.name] = state;
    if (Object.keys(states).length === 0) delete cfg.skillStates;
    else cfg.skillStates = states;
  });
  return state;
}

export function modelMayInvokeSkill(skill: Skill): boolean {
  return skillStateFor(skill) === "on";
}

export function modelSkillListingMode(skill: Skill): "full" | "name-only" | "hidden" {
  const state = skillStateFor(skill);
  if (state === "on") return "full";
  if (state === "name-only") return "name-only";
  return "hidden";
}

export function userMayInvokeSkill(skill: Skill): boolean {
  return skillStateFor(skill) !== "off";
}
