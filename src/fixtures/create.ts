import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { allocateWorkspace, removeWorkspace } from "./workspace-state";
import { fixtureBinDirectory, installFixtureBin } from "./bin";
import { installGitHooks } from "./git-hooks";
import {
  materializeGeneratedFixture,
  type GeneratedFixture,
} from "./generated";
import { runFixtureSetup, type FixtureSetup } from "./setup";
import {
  fixtureParts,
  safePreparationTarget,
  type InlineArtifact,
  type PreparationSources,
} from "./preparation";
import {
  applyRepositoryOverlay,
  cloneRepositorySource,
  type RepositoryFixture,
  type RepositorySource,
} from "./repository";
import {
  EvaluationConfigurationError,
  type ResolvedCase,
} from "../evaluation/types";

export async function createFixture(
  fixture: ResolvedCase["fixture"],
  artifacts: InlineArtifact[],
  sources: PreparationSources | undefined,
  repository: RepositorySource | null,
  repositoryFixture: RepositoryFixture | null,
  generated: GeneratedFixture | null,
  setup: FixtureSetup | null,
  projectRoot: string,
  signal?: AbortSignal,
  reservedWorkspace?: string,
): Promise<string> {
  const paths = inlineFixturePaths(fixture, generated, repository);
  const workspace = reservedWorkspace ?? (await allocateWorkspace());
  try {
    await initializeFixtureHistory(
      fixture,
      sources,
      repository,
      repositoryFixture,
      generated,
      workspace,
    );
    await installDeclaredFixtureTools(
      generated ?? repositoryFixture,
      workspace,
    );
    await writeInlineFixtureFiles(paths, workspace);
    await setupFixture(setup, workspace, projectRoot, signal);
    await mountPreparationArtifacts(artifacts, workspace);
    await excludePreparationArtifacts(artifacts, workspace);
    await fixtureBinDirectory(workspace);
    return workspace;
  } catch (error) {
    if (!reservedWorkspace) await removeWorkspace(workspace);
    throw error;
  }
}

function inlineFixturePaths(
  fixture: ResolvedCase["fixture"],
  generated: GeneratedFixture | null,
  repository: RepositorySource | null,
) {
  return Object.entries(
    generated || repository ? {} : (fixture.files ?? {}),
  ).map(([path, content]) => ({ path, parts: fixtureParts(path), content }));
}

async function cloneFixtureRepository(
  fixture: ResolvedCase["fixture"],
  sources: PreparationSources | undefined,
  repository: RepositorySource,
  workspace: string,
): Promise<void> {
  if (!fixture.sourceRef || !sources)
    throw new EvaluationConfigurationError(
      "repository source root is required and must be absolute",
    );
  await cloneRepositorySource(
    fixture.sourceRef,
    sources,
    repository,
    workspace,
  );
}

async function initializeFixtureHistory(
  fixture: ResolvedCase["fixture"],
  sources: PreparationSources | undefined,
  repository: RepositorySource | null,
  repositoryFixture: RepositoryFixture | null,
  generated: GeneratedFixture | null,
  workspace: string,
): Promise<void> {
  if (repository)
    await cloneFixtureRepository(fixture, sources, repository, workspace);
  if (generated) await materializeGeneratedFixture(generated, workspace);
  if (repositoryFixture)
    await applyRepositoryOverlay(repositoryFixture, workspace);
}

async function installDeclaredFixtureTools(
  fixture: GeneratedFixture | RepositoryFixture | null,
  workspace: string,
): Promise<void> {
  await installFixtureBin(fixture?.bin, workspace);
  await installGitHooks(fixture?.hooks, workspace);
}

async function writeInlineFixtureFiles(
  files: ReturnType<typeof inlineFixturePaths>,
  workspace: string,
): Promise<void> {
  for (const file of files) {
    const target = join(workspace, ...file.parts);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, file.content, { flag: "wx", mode: 0o600 });
  }
}

async function setupFixture(
  setup: FixtureSetup | null,
  workspace: string,
  projectRoot: string,
  signal?: AbortSignal,
): Promise<void> {
  if (!setup) return;
  await runFixtureSetup(setup, {
    workspace,
    projectRoot,
    fixtureBinDir: (await fixtureBinDirectory(workspace)) ?? undefined,
    signal,
  });
}

async function mountPreparationArtifacts(
  artifacts: InlineArtifact[],
  workspace: string,
): Promise<void> {
  for (const artifact of artifacts) {
    const target = await safePreparationTarget(
      workspace,
      artifact.relativePath,
    );
    await writeFile(target, artifact.bytes, {
      flag: "wx",
      mode: artifact.executable ? 0o700 : 0o600,
    });
  }
}

async function excludePreparationArtifacts(
  artifacts: InlineArtifact[],
  workspace: string,
): Promise<void> {
  const gitExcluded = artifacts.filter((artifact) => artifact.gitExclude);
  if (!gitExcluded.length) return;
  const special = new Set(["\\", "*", "?", "[", "]", "#", "!", " "]);
  const patterns = gitExcluded.map((artifact) =>
    Array.from(artifact.relativePath)
      .map((character) =>
        special.has(character) ? `\\${character}` : character,
      )
      .join(""),
  );
  await appendFile(
    join(workspace, ".git", "info", "exclude"),
    `\n${patterns.map((path) => `/${path}`).join("\n")}\n`,
  );
}
