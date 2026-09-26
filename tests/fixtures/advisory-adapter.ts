import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { HostAdapter } from "../../src/engine";

const host: HostAdapter = {
  id: "sevro.host.advisory-synthetic",
  model: "advisory-v1",
  effort: "low",
  async run({ prompt, workspace }) {
    if (!prompt.includes("Deterministic checks"))
      throw new Error("advisory prompt omitted check facts");
    if (await Bun.file(join(workspace, ".agents", "condition.txt")).exists())
      throw new Error("advisory view exposed condition files");
    if (
      (await readFile(join(workspace, "app.ts"), "utf8")) !==
      "export const value = 2;\n"
    )
      throw new Error("advisory view omitted the candidate change");
    return {
      finalMessage: JSON.stringify({
        verdict: "fail",
        overallScore: 2,
        dimensions: {
          correctness: 2,
          maintainability: 3,
          testQuality: 2,
          scopeDiscipline: 4,
        },
        strengths: ["Small change"],
        weaknesses: ["Missing validation"],
        summary: "A correctness gap remains.",
      }),
      complete: true,
    };
  },
};

export default host;
