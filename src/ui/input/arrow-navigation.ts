export interface PromptArrowNavigationState {
  locked: boolean;
  upArrow: boolean;
  downArrow: boolean;
  slashOptionCount: number;
}

export function promptOwnsArrowNavigation(state: PromptArrowNavigationState): boolean {
  if (!state.locked) return true;
  if (!state.upArrow && !state.downArrow) return true;
  return state.slashOptionCount > 0;
}
