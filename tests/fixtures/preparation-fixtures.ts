import { createHash } from "node:crypto";
import { type PreparationArtifact } from "../../src/fixtures/preparation";

export function inlineArtifact(
  bytes = Buffer.from("prepared\n"),
): PreparationArtifact {
  return {
    id: "example.prepared",
    relativePath: "assets/prepared.txt",
    sha256: createHash("sha256").update(bytes).digest("hex"),
    contentBase64: bytes.toString("base64"),
  };
}

export const generatedBaseline = {
  kind: "generated",
  commits: [{ message: "Baseline", files: { "README.md": "baseline" } }],
};
