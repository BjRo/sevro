import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import ts from "typescript";
import { createInstrumenter } from "istanbul-lib-instrument";
import { deriveCompilerExemptions } from "./compiler-exemptions";
import { object } from "./records.mjs";

export const generatedFiles = [
  "cli-result",
  "extension",
  "report",
  "run-evidence",
].map((name) => `src/generated/${name}.cjs`);
const analyzerFiles = [
  "compiler-flow.ts",
  "compiler-counter-copy.ts",
  "compiler-exemptions.ts",
  "compiler-counter-ownership.ts",
];
export function sourceDigest(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
export function analyzerIdentity(repo: string) {
  return {
    version: "sevro-compiler-private-flow-v1",
    typescript: ts.version,
    files: analyzerFiles.map((file) => ({
      file: `scripts/coverage/${file}`,
      sha256: sourceDigest(
        readFileSync(join(repo, "scripts/coverage", file), "utf8"),
      ),
    })),
  };
}

export function buildCompilerManifest(repo: string) {
  return {
    version: 2,
    status: "proposed-for-independent-review",
    reasonId: "ajv-compiler-private-local-flow",
    instrumenter: "istanbul-lib-instrument@6.0.3",
    analyzer: analyzerIdentity(repo),
    files: generatedFiles.map((file) => manifestFile(repo, file)),
  };
}

function manifestFile(repo: string, file: string) {
  const path = join(repo, file),
    text = readFileSync(path, "utf8");
  const instrumenter = createInstrumenter({
    esModules: false,
    parserPlugins: ["typescript"],
    compact: false,
  });
  instrumenter.instrumentSync(text, path);
  return {
    file,
    sha256: sourceDigest(text),
    ...deriveCompilerExemptions(text, instrumenter.lastFileCoverage()),
  };
}

export type Manifest = {
  version: number;
  status: string;
  reasonId: string;
  instrumenter: string;
  analyzer: unknown;
  files: ManifestFile[];
};
export type ManifestFile = {
  file: string;
  sha256: string;
  proofs: unknown;
  exemptions: unknown;
};
function string(value: unknown): string {
  if (typeof value !== "string")
    throw new Error("Invalid compiler manifest text");
  return value;
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("Invalid compiler manifest array");
  return value as unknown[];
}
export function readCompilerManifest(repo: string): Manifest {
  const entry = object(
    JSON.parse(
      readFileSync(
        join(repo, "docs/typescript-coverage-exemptions.json"),
        "utf8",
      ),
    ) as unknown,
  );
  if (
    entry.version !== 2 ||
    entry.reasonId !== "ajv-compiler-private-local-flow" ||
    entry.instrumenter !== "istanbul-lib-instrument@6.0.3"
  )
    throw new Error("Incompatible coverage exemption policy");
  if (JSON.stringify(entry.analyzer) !== JSON.stringify(analyzerIdentity(repo)))
    throw new Error("Stale compiler analyzer proof");
  return {
    version: entry.version,
    status: string(entry.status),
    reasonId: entry.reasonId,
    instrumenter: entry.instrumenter,
    analyzer: entry.analyzer,
    files: array(entry.files).map(readFile),
  };
}
function readFile(value: unknown): ManifestFile {
  const entry = object(value),
    file = string(entry.file);
  if (!generatedFiles.includes(file))
    throw new Error("Undeclared coverage exemption scope");
  return {
    file,
    sha256: string(entry.sha256),
    proofs: entry.proofs,
    exemptions: entry.exemptions,
  };
}
