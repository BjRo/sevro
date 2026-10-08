import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { copySnapshot, candidateFiles } from "./prepare";

function participantFiles(root: string): string[] {
  return [
    ...new Bun.Glob("**/*").scanSync({ cwd: root, dot: true, onlyFiles: true }),
  ]
    .filter(
      (file) =>
        !/^(?:node_modules|\.git|\.quality|\.worktrees)(?:\/|$)/.test(file),
    )
    .filter((file) => file !== "bunfig.toml")
    .sort();
}

function sameBytes(original: string, copy: string): void {
  if (!readFileSync(original).equals(readFileSync(copy)))
    throw new Error(`Candidate snapshot content differs: ${original}`);
}

type Snapshot = ReturnType<typeof copySnapshot>;

function verifyInputs(repo: string, snapshot: Snapshot): void {
  const expected = candidateFiles(repo).filter(
    (file) => file !== "bunfig.toml",
  );
  if (
    JSON.stringify(expected) !==
    JSON.stringify(participantFiles(snapshot.project))
  )
    throw new Error(
      "Candidate snapshot inputs differ: omitted or deleted files",
    );
  for (const file of expected)
    sameBytes(
      join(repo, file),
      join(file.startsWith("src/") ? snapshot.source : snapshot.project, file),
    );
}

function verifyIsolation(snapshot: Snapshot): void {
  if (
    readFileSync(join(snapshot.project, ".git/HEAD"), "utf8").startsWith(
      "gitdir:",
    )
  )
    throw new Error("Candidate snapshot did not isolate Git metadata");
  for (const ignored of [".quality", ".guide-evals", ".worktrees"])
    if (existsSync(join(snapshot.project, ignored)))
      throw new Error(`Candidate snapshot leaked ignored input: ${ignored}`);
  if (!lstatSync(join(snapshot.project, "node_modules")).isSymbolicLink())
    throw new Error("Candidate snapshot copied dependency inputs");
}

export function snapshotProbe(repo: string): void {
  const directory = mkdtempSync(join(tmpdir(), "sevro-snapshot-probe-"));
  try {
    const snapshot = copySnapshot(repo, directory);
    verifyInputs(repo, snapshot);
    verifyIsolation(snapshot);
    console.log(
      "candidate-snapshot: exact inputs, deletions and independent Git preserved",
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
