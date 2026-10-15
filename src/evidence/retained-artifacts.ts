import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { sha256 } from "../identity";

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
