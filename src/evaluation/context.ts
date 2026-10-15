import type { ResultCollector } from "./collection";
import type { PreparedEvaluation } from "./plan";
import type { PreparationArtifactReference, RunResources } from "./resources";

export interface EvaluationContext {
  readonly prepared: PreparedEvaluation;
  readonly resources: RunResources;
  readonly results: ResultCollector;
  readonly preparationArtifacts: readonly PreparationArtifactReference[];
}
