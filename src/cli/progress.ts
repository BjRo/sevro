import type { EvaluationProgress } from "../evaluation/types";

export function displayProgress(event: EvaluationProgress): void {
  const trial = event.trial === undefined ? "" : ` trial=${event.trial}`;
  process.stderr.write(`sevro: ${event.stage} ${event.status}${trial}\n`);
}
