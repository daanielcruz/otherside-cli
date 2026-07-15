export { maybeCompact } from "./auto.ts";
export {
  type ForceCompactOptions,
  type ForceCompactResult,
  forceCompact,
  forceCompactOnOverflow,
} from "./manual.ts";
export { maybeMicroCompact } from "./micro.ts";
export { type ContextOverflow, checkContextOverflow } from "./overflow.ts";
export type {
  CompactOrchestrationDeps,
  CompactState,
} from "./support.ts";
