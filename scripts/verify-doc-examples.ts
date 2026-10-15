import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  candidatePackage,
  verifyConsumer,
  verifyContributor,
} from "./documentation-example-packages";
import { shellExample } from "./documentation-example-results";
import { verifyRecipes } from "./documentation-recipes";

const root = resolve(import.meta.dir, "..");
const temporary = await realpath(
  await mkdtemp(join(tmpdir(), "sevro-doc-examples-")),
);
try {
  const text = await readFile(join(root, "docs/getting-started.md"), "utf8");
  const consumerCommand = shellExample(text, "consumer");
  const contributorCommand = shellExample(text, "contributor");
  const candidate = await candidatePackage(root, temporary);
  const installedCandidate = await verifyConsumer(
    root,
    temporary,
    consumerCommand,
    "candidate-consumer",
    candidate.archive,
    candidate.license,
  );
  await verifyConsumer(
    root,
    temporary,
    consumerCommand,
    "published-consumer",
    candidate.published,
    candidate.license,
  );
  await verifyContributor(root, temporary, contributorCommand);
  await verifyRecipes(root, temporary, installedCandidate);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
