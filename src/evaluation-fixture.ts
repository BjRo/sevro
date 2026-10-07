import { isRecord } from "./value-guards";
import { createHash } from "node:crypto";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson } from "./identity";
import { fixtureBinDirectory, installFixtureBin } from "./fixture-bin";
import { installGitHooks } from "./git-hooks";
import {
  materializeGeneratedFixture,
  type GeneratedFixture,
} from "./generated-fixture";
import { runFixtureSetup, type FixtureSetup } from "./fixture-setup";
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
} from "./repository-fixture";
import {
  EvaluationConfigurationError,
  type HostResult,
  type ResolvedCase,
} from "./evaluation-types";

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
  const workspace =
    reservedWorkspace ??
    (await realpath(await mkdtemp(join(tmpdir(), "sevro-case-"))));
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
    if (!reservedWorkspace)
      await rm(workspace, { recursive: true, force: true });
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

export function sha256(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

export function hostObservations(
  result: HostResult,
  hostId: string,
  existingIds: Set<string>,
) {
  const items = result.observations ?? [];
  if (items.length > 128) throw new Error("too many host observations");
  const ids = new Set([...existingIds, "sevro.observation.final-message"]);
  let totalBytes = 0;
  return items.map((value: unknown) => {
    const item = validatedHostObservation(value, ids);
    ids.add(item.id);
    const data = canonicalJson(item.data);
    totalBytes += Buffer.byteLength(data, "utf8");
    if (totalBytes > 8 * 1024 * 1024)
      throw new Error("host observations exceed 8 MiB");
    return {
      id: item.id,
      source: hostId,
      completeness: item.completeness,
      data: JSON.parse(data) as Record<string, unknown>,
    };
  });
}

export function hostArtifacts(result: HostResult, existingIds: Set<string>) {
  const items = result.artifacts ?? [];
  if (!Array.isArray(items) || items.length > 32)
    throw new Error("too many host artifacts");
  const ids = new Set(existingIds);
  let totalBytes = 0;
  return items.map((value: unknown) => {
    const item = validatedHostArtifact(value, ids);
    ids.add(item.id);
    totalBytes += item.bytes.byteLength;
    if (
      item.bytes.byteLength > 8 * 1024 * 1024 ||
      totalBytes > 32 * 1024 * 1024
    )
      throw new Error("host artifacts exceed the size limit");
    return { id: item.id, bytes: Buffer.from(item.bytes) };
  });
}

function validEvidenceId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)+$/.test(value)
  );
}

function validObservationId(value: unknown, ids: Set<string>): value is string {
  return (
    validEvidenceId(value) &&
    !value.startsWith("sevro.observation.") &&
    !ids.has(value)
  );
}

function validCompleteness(
  value: unknown,
): value is "complete" | "partial" | "unavailable" {
  return value === "complete" || value === "partial" || value === "unavailable";
}

function validatedHostObservation(value: unknown, ids: Set<string>) {
  if (!isRecord(value)) throw new Error("invalid host observation");
  if (
    !validObservationId(value.id, ids) ||
    !validCompleteness(value.completeness) ||
    !isRecord(value.data)
  )
    throw new Error("invalid host observation");
  return { id: value.id, completeness: value.completeness, data: value.data };
}

function validArtifactId(value: unknown, ids: Set<string>): value is string {
  return validEvidenceId(value) && !ids.has(value);
}

function validatedHostArtifact(value: unknown, ids: Set<string>) {
  if (!isRecord(value)) throw new Error("invalid host artifact");
  if (!validArtifactId(value.id, ids) || !(value.bytes instanceof Uint8Array))
    throw new Error("invalid host artifact");
  return { id: value.id, bytes: value.bytes };
}

export async function verifyRetainedArtifacts(
  artifacts: { path: string; sha256: string }[],
): Promise<void> {
  for (const artifact of artifacts) {
    let actual: string;
    try {
      actual = sha256(await readFile(fileURLToPath(artifact.path)));
    } catch {
      throw new Error("retained preparation artifact is unreadable");
    }
    if (actual !== artifact.sha256)
      throw new Error("retained preparation artifact changed");
  }
}

export function usage(result: HostResult | null) {
  return result === null
    ? { inputTokens: null, outputTokens: null, costUsd: null, complete: false }
    : availableUsage(result);
}

function availableUsage(result: HostResult) {
  return {
    inputTokens: result.inputTokens ?? null,
    outputTokens: result.outputTokens ?? null,
    costUsd: result.costUsd ?? null,
    complete: result.usageComplete ?? false,
  };
}
