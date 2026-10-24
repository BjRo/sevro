import { afterAll, beforeAll } from "bun:test";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTemporaryFixtures } from "./filesystem";

/** Keep real extension processes without repeatedly hashing the Bun executable. */
export function extensionFixtureCommand() {
  const { temporaryFixture, cleanupTemporaryFixtures } =
    createTemporaryFixtures();

  let root = "";
  let launcher = "";
  beforeAll(async () => {
    if (process.platform === "win32") return;
    root = await temporaryFixture(join(tmpdir(), "sevro-extension-launcher-"));
    launcher = join(root, "extension");
    const binary = "'" + process.execPath.replaceAll("'", "'\"'\"'") + "'";
    await writeFile(launcher, `#!/bin/sh\nexec ${binary} "$@"\n`, {
      mode: 0o700,
    });
  });
  afterAll(cleanupTemporaryFixtures);
  return (source: string, scenario: string) => [
    launcher || process.execPath,
    source,
    scenario,
  ];
}
