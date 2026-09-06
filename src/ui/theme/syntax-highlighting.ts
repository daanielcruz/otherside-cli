/**
 * Whether code in the transcript is coloured by language, as opposed to only by
 * what a diff added and removed.
 *
 * Held live rather than read per render: the surfaces that ask are repainted on
 * every keystroke, and resolving config there would put disk reads on the key
 * path. Boot seeds it once and the theme picker flips it.
 */
let enabled = true;

export function isSyntaxHighlightingEnabled(): boolean {
  return enabled;
}

export function setSyntaxHighlightingEnabled(next: boolean): void {
  enabled = next;
}
