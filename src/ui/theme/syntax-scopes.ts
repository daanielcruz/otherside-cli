import type { ThemeName } from "@/kernel/config/theme-names.ts";
import type { TerminalColor } from "@/terminal-runtime";

export interface ScopeMap {
  [scope: string]: TerminalColor;
}

export const STORAGE_KEYWORDS = new Set([
  "const",
  "let",
  "var",
  "function",
  "class",
  "type",
  "interface",
  "enum",
  "namespace",
  "module",
  "def",
  "fn",
  "func",
  "struct",
  "trait",
  "impl",
  "package",
  "import",
  "export",
  "from",
  "as",
  "return",
  "void",
  "static",
  "public",
  "private",
  "protected",
  "abstract",
  "final",
]);

const MONOKAI: ScopeMap = {
  keyword: "#F92672",
  _storage: "#66D9EF",
  built_in: "#A6E22E",
  type: "#A6E22E",
  literal: "#BE84FF",
  number: "#BE84FF",
  string: "#E6DB74",
  title: "#A6E22E",
  "title.function": "#A6E22E",
  "title.class": "#A6E22E",
  "title.class.inherited": "#A6E22E",
  params: "#FD971F",
  comment: "#75715E",
  meta: "#75715E",
  attr: "#A6E22E",
  attribute: "#A6E22E",
  variable: "#FFFFFF",
  "variable.language": "#FFFFFF",
  property: "#FFFFFF",
  operator: "#F92672",
  punctuation: "#F8F8F2",
  symbol: "#BE84FF",
  regexp: "#E6DB74",
  subst: "#F8F8F2",
};

const GITHUB: ScopeMap = {
  keyword: "#A71D5D",
  _storage: "#A71D5D",
  built_in: "#0086B3",
  type: "#0086B3",
  literal: "#0086B3",
  number: "#0086B3",
  string: "#183691",
  title: "#795DA3",
  "title.function": "#795DA3",
  "title.class": "#000000",
  "title.class.inherited": "#000000",
  params: "#0086B3",
  comment: "#969896",
  meta: "#969896",
  attr: "#0086B3",
  attribute: "#0086B3",
  variable: "#0086B3",
  "variable.language": "#0086B3",
  property: "#0086B3",
  operator: "#A71D5D",
  punctuation: "#333333",
  symbol: "#0086B3",
  regexp: "#183691",
  subst: "#333333",
};

const ANSI: ScopeMap = {
  keyword: "ansi:magenta",
  _storage: "ansi:cyan",
  built_in: "ansi:green",
  type: "ansi:green",
  literal: "ansi:magenta",
  number: "ansi:magenta",
  string: "ansi:yellow",
  title: "ansi:green",
  "title.function": "ansi:green",
  "title.class": "ansi:green",
  "title.class.inherited": "ansi:green",
  params: "ansi:yellow",
  comment: "ansi:blackBright",
  meta: "ansi:blackBright",
  attr: "ansi:green",
  attribute: "ansi:green",
  variable: "ansi:white",
  "variable.language": "ansi:white",
  property: "ansi:white",
  operator: "ansi:magenta",
  punctuation: "ansi:white",
  symbol: "ansi:magenta",
  regexp: "ansi:yellow",
  subst: "ansi:white",
};

export function scopesForTheme(theme: ThemeName): ScopeMap {
  if (theme.includes("ansi")) return ANSI;
  if (theme.includes("dark")) return MONOKAI;
  return GITHUB;
}

/**
 * What to call the scope map a palette resolves to, for a surface that names it.
 *
 * It answers here because the choice is the same one `scopesForTheme` makes: a
 * name kept anywhere else would be a second place to update when a map changes.
 */
export function scopeSchemeName(theme: ThemeName): string {
  if (theme.includes("ansi")) return "ansi";
  if (theme.includes("dark")) return "Monokai";
  return "GitHub";
}

export function defaultForegroundForTheme(theme: ThemeName): TerminalColor {
  if (theme.includes("ansi")) return "ansi:white";
  if (theme.includes("dark")) return "#F8F8F2";
  return "#333333";
}

export function resolveScope(args: {
  scope: string | undefined;
  text: string;
  scopes: ScopeMap;
  fallback: TerminalColor;
}): TerminalColor {
  const { scope, text, scopes, fallback } = args;
  if (!scope) return fallback;
  if (scope === "keyword" && STORAGE_KEYWORDS.has(text.trim())) {
    return scopes._storage ?? fallback;
  }
  const exact = scopes[scope];
  if (exact) return exact;
  const root = scope.split(".")[0];
  const rooted = root ? scopes[root] : undefined;
  if (rooted) return rooted;
  return fallback;
}
