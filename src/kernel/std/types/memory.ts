export type MemoryScope = "user" | "project" | "nested" | "automem";

export interface MemoryFile {
  path: string;
  content: string;
  scope: MemoryScope;
}
