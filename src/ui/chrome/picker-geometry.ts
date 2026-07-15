// Session pickers (/resume, /rewind) share one height budget: 65% of the
// terminal, so both lists breathe without displacing the shell below.
export const PICKER_HEIGHT_FRACTION = 0.65;

export function pickerMaxHeight(terminalRows: number): number {
  return Math.floor(terminalRows * PICKER_HEIGHT_FRACTION);
}
