/**
 * The `<system-reminder>` wrapper, as a shape rather than a layer.
 *
 * Which layers wrap their text is the manifest's business; what the wrapper
 * looks like is shared by everyone who has to put one on or take one off. It
 * lives beside the composer so the compose iterator never reaches into a layer
 * module to borrow it.
 */
export function stripSystemReminderWrapper(text: string): string {
  return text.replace(/^<system-reminder>\n?/, "").replace(/\n?<\/system-reminder>$/, "");
}
