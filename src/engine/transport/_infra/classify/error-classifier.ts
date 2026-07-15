import { baselineClassifier } from "@/engine/transport/_infra/classify/classifiers/baseline.ts";
import type { RetryDecisionDetailed } from "@/engine/transport/_infra/classify/classify.ts";
import type { ErrorMeta } from "@/engine/transport/error-meta.ts";

export interface ErrorClassifierInput {
  err: unknown;
  decision: RetryDecisionDetailed;
  provider: string;
  model: string;
  attempt: number;
  source: ErrorMeta["source"];
}

export interface ErrorClassifier {
  id: string;
  classify(input: ErrorClassifierInput): ErrorMeta | null;
}

const registry: ErrorClassifier[] = [];

export function registerErrorClassifier(classifier: ErrorClassifier): void {
  registry.unshift(classifier);
}

export function resetErrorClassifiers(): void {
  registry.length = 0;
}

export function classifyError(input: ErrorClassifierInput): ErrorMeta {
  for (const c of registry) {
    const meta = c.classify(input);
    if (meta) return meta;
  }
  return baselineClassifier.classify(input) as ErrorMeta;
}
