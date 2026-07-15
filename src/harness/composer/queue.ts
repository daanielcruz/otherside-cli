import type { InjectionQueue } from "@/harness/composer/injections.ts";

export function makeQueue(): InjectionQueue {
  const buf: string[] = [];
  return {
    drain() {
      const out = [...buf];
      buf.length = 0;
      return out;
    },
    peek() {
      return buf;
    },
    push(s) {
      buf.push(s);
    },
  };
}
