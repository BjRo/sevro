import { guideMain } from "./guide/cli";

export { answerChecks, semanticChecks } from "./guide/answers";
export {
  usedGuide,
  inspectedSources,
  effectAttempts,
} from "./guide/observations";
export { readOnlyCommand } from "./guide/commands";

if (import.meta.main) await guideMain();
