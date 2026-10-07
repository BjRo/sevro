import type { ExtensionCase } from "./extension-session";
import type { RepositoryFixture } from "./repository-fixture";

function repositoryOverlay(fixture: RepositoryFixture) {
  return {
    ...(fixture.files ? { files: fixture.files } : {}),
    ...(fixture.staged ? { staged: fixture.staged } : {}),
    ...(fixture.commitFiles ? { commitFiles: true } : {}),
  };
}

function repositoryTools(fixture: RepositoryFixture) {
  return {
    ...(fixture.hooks ? { hooks: fixture.hooks } : {}),
    ...(fixture.bin ? { bin: fixture.bin } : {}),
  };
}

/** Translate negotiated fixture declarations into the standalone case representation. */
export function resolvedFixture(fixture: ExtensionCase["fixture"]) {
  switch (fixture.kind) {
    case "inline":
      return { files: fixture.files };
    case "repository":
      return {
        sourceRef: fixture.sourceRef,
        ...repositoryOverlay(fixture),
        ...repositoryTools(fixture),
      };
    case "generated":
      return fixture;
  }
}
