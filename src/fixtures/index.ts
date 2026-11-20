/**
 * Fixtures and the workspaces they are materialized into.
 *
 * Planning validates generated and repository fixture declarations, setup
 * commands and prepared artifacts, then each trial materializes the fixture
 * into its own isolated workspace. Advisory review gets a blind workspace copy
 * of a finished trial. Git snapshots, fixture tools, hooks and setup processes stay inside.
 */
export { buildBlindAdvisoryWorkspace, advisoryBaseRevision } from "./advisory";
export { fixtureBinDirectory } from "./bin";
export { materializeFixture, type FixtureSource } from "./create";
export { prepareGeneratedFixture } from "./generated";
export {
  fixtureParts,
  prepareArtifacts,
  type InlineArtifact,
  type PreparationArtifact,
  type PreparationSources,
} from "./preparation";
export {
  prepareRepositoryFixture,
  resolveRepositorySource,
} from "./repository";
export {
  prepareFixtureSetup,
  type FixtureSetup,
  type FixtureSetupDeclaration,
} from "./setup";
