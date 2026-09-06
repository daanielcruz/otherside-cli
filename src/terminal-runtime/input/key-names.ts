const legacyKeyEntries = [
  ["OP", "f1"],
  ["OQ", "f2"],
  ["OR", "f3"],
  ["OS", "f4"],
  ["Op", "0"],
  ["Oq", "1"],
  ["Or", "2"],
  ["Os", "3"],
  ["Ot", "4"],
  ["Ou", "5"],
  ["Ov", "6"],
  ["Ow", "7"],
  ["Ox", "8"],
  ["Oy", "9"],
  ["Oj", "*"],
  ["Ok", "+"],
  ["Ol", ","],
  ["Om", "-"],
  ["On", "."],
  ["Oo", "/"],
  ["OM", "return"],
  ["[11~", "f1"],
  ["[12~", "f2"],
  ["[13~", "f3"],
  ["[14~", "f4"],
  ["[[A", "f1"],
  ["[[B", "f2"],
  ["[[C", "f3"],
  ["[[D", "f4"],
  ["[[E", "f5"],
  ["[15~", "f5"],
  ["[17~", "f6"],
  ["[18~", "f7"],
  ["[19~", "f8"],
  ["[20~", "f9"],
  ["[21~", "f10"],
  ["[23~", "f11"],
  ["[24~", "f12"],
  ["[A", "up"],
  ["[B", "down"],
  ["[C", "right"],
  ["[D", "left"],
  ["[E", "clear"],
  ["[F", "end"],
  ["[H", "home"],
  ["OA", "up"],
  ["OB", "down"],
  ["OC", "right"],
  ["OD", "left"],
  ["OE", "clear"],
  ["OF", "end"],
  ["OH", "home"],
  ["[1~", "home"],
  ["[2~", "insert"],
  ["[3~", "delete"],
  ["[4~", "end"],
  ["[5~", "pageup"],
  ["[6~", "pagedown"],
  ["[[5~", "pageup"],
  ["[[6~", "pagedown"],
  ["[7~", "home"],
  ["[8~", "end"],
  ["[a", "up"],
  ["[b", "down"],
  ["[c", "right"],
  ["[d", "left"],
  ["[e", "clear"],
  ["[2$", "insert"],
  ["[3$", "delete"],
  ["[5$", "pageup"],
  ["[6$", "pagedown"],
  ["[7$", "home"],
  ["[8$", "end"],
  ["Oa", "up"],
  ["Ob", "down"],
  ["Oc", "right"],
  ["Od", "left"],
  ["Oe", "clear"],
  ["[2^", "insert"],
  ["[3^", "delete"],
  ["[5^", "pageup"],
  ["[6^", "pagedown"],
  ["[7^", "home"],
  ["[8^", "end"],
  ["[Z", "tab"],
] as const;

const legacyKeyNames: Readonly<Record<string, string>> = Object.fromEntries(legacyKeyEntries);
const shiftEncodedKeys = new Set([
  "[a",
  "[b",
  "[c",
  "[d",
  "[e",
  "[2$",
  "[3$",
  "[5$",
  "[6$",
  "[7$",
  "[8$",
  "[Z",
]);
const ctrlEncodedKeys = new Set([
  "Oa",
  "Ob",
  "Oc",
  "Od",
  "Oe",
  "[2^",
  "[3^",
  "[5^",
  "[6^",
  "[7^",
  "[8^",
]);

export const namedLegacyKeys = Object.values(legacyKeyNames).filter((name) => name.length > 1);

export function resolveLegacyKey(code: string): {
  name: string | undefined;
  shift: boolean;
  ctrl: boolean;
} {
  return {
    name: legacyKeyNames[code],
    shift: shiftEncodedKeys.has(code),
    ctrl: ctrlEncodedKeys.has(code),
  };
}

const numpadOperators = [".", "/", "*", "-", "+", "return", "="] as const;

export function resolveCodePointName(codePoint: number): string | undefined {
  const controlNames: Readonly<Record<number, string>> = {
    9: "tab",
    13: "return",
    27: "escape",
    32: "space",
    127: "backspace",
  };
  const controlName = controlNames[codePoint];
  if (controlName) return controlName;

  if (codePoint >= 57399 && codePoint <= 57408) return String(codePoint - 57399);
  if (codePoint >= 57409 && codePoint <= 57415) return numpadOperators[codePoint - 57409];
  if (codePoint >= 32 && codePoint <= 126) return String.fromCharCode(codePoint).toLowerCase();
  return undefined;
}
