import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildCompilerManifest } from "./compiler-manifest";

const root = resolve(import.meta.dir, "../..");
writeFileSync(
  resolve(root, "docs/typescript-coverage-exemptions.json"),
  JSON.stringify(buildCompilerManifest(root), null, 2) + "\n",
);
