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

export type FixtureSource<Repository = RepositorySource> =
  | { kind: "inline"; files: ResolvedCase["fixture"]["files"] }
  | { kind: "generated"; fixture: GeneratedFixture }
  | { kind: "repository"; fixture: RepositoryFixture; repository: Repository };

interface FixtureOptions {
  artifacts?: InlineArtifact[];
  sources?: PreparationSources;
  setup?: FixtureSetup | null;
  projectRoot: string;
  signal?: AbortSignal;
  reservedWorkspace?: string;
  candidateRuntimeRoot?: string;
}

export async function createFixture(
  source: FixtureSource,
  options: FixtureOptions,
): Promise<string> {
  const paths = inlineFixturePaths(source);
  const artifacts = options.artifacts ?? [];
  const workspace = options.reservedWorkspace ?? (await allocateWorkspace());
  try {
    await initializeFixtureHistory(source, options.sources, workspace);
    await installDeclaredFixtureTools(source, workspace);
    await writeInlineFixtureFiles(paths, workspace);
    await setupFixture(
      options.setup,
      workspace,
      options.projectRoot,
      options.signal,
      options.candidateRuntimeRoot,
    );
    await mountPreparationArtifacts(artifacts, workspace);
    await excludePreparationArtifacts(artifacts, workspace);
    await fixtureBinDirectory(workspace);
    return workspace;
  } catch (error) {
    if (!options.reservedWorkspace) await removeWorkspace(workspace);
    throw error;
  }
}

function inlineFixturePaths(source: FixtureSource) {
  return Object.entries(
    source.kind === "inline" ? (source.files ?? {}) : {},
  ).map(([path, content]) => ({ path, parts: fixtureParts(path), content }));
}

async function cloneFixtureRepository(
  source: Extract<FixtureSource, { kind: "repository" }>,
  sources: PreparationSources | undefined,
  workspace: string,
): Promise<void> {
  if (!sources)
    throw new EvaluationConfigurationError(
      "repository source root is required and must be absolute",
    );
  await cloneRepositorySource(
    source.fixture.sourceRef,
    sources,
    source.repository,
    workspace,
  );
}

async function initializeFixtureHistory(
  source: FixtureSource,
  sources: PreparationSources | undefined,
  workspace: string,
): Promise<void> {
  switch (source.kind) {
    case "repository":
      await cloneFixtureRepository(source, sources, workspace);
      await applyRepositoryOverlay(source.fixture, workspace);
      break;
    case "generated":
      await materializeGeneratedFixture(source.fixture, workspace);
      break;
    case "inline":
      break;
  }
}

async function installDeclaredFixtureTools(
  source: FixtureSource,
  workspace: string,
): Promise<void> {
  const fixture = source.kind === "inline" ? undefined : source.fixture;
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
  setup: FixtureSetup | null | undefined,
  workspace: string,
  projectRoot: string,
  signal?: AbortSignal,
  candidateRuntimeRoot?: string,
): Promise<void> {
  if (!setup) return;
  await runFixtureSetup(setup, {
    workspace,
    projectRoot,
    fixtureBinDir: (await fixtureBinDirectory(workspace)) ?? undefined,
    signal,
    candidateRuntimeRoot,
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
