import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { releaseDocumentation } from "./release-documentation";

const { path, expected } = await releaseDocumentation(
  resolve(import.meta.dir, ".."),
);
await writeFile(path, expected);
console.log("Current release documentation synchronized");
