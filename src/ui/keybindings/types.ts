export type KeybindingAction = string;
export type KeybindingContextName = string;

export type ParsedKeystroke = {
  key: string;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
  super: boolean;
};

export type Chord = ParsedKeystroke[];

export type ParsedBinding = {
  chord: Chord;
  action: KeybindingAction;
  context: KeybindingContextName;
};

export type KeybindingBlock = {
  context: KeybindingContextName;
  bindings: Record<string, KeybindingAction | undefined>;
};
