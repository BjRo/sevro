/**
 * Candidate fixture workspaces.
 *
 * Planning validates generated and repository fixture declarations, setup
 * commands and prepared artifacts, then trials materialize one isolated fixture
 * from the resulting source. Advisory review gets a blind copy of a finished
 * trial. Git snapshots, fixture tools, hooks and setup processes stay inside.
 */
export { buildBlindAdvisoryFixture, advisoryBaseRevision } from "./advisory";
export { fixtureBinDirectory } from "./bin";
export { createFixture, type FixtureSource } from "./create";
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
