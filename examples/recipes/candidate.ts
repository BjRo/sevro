import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Trusted, deterministic participant for exercising the recipe's real graders. */
const host = {
  id: "recipes.deterministic",
  model: "fixture-editor",
  effort: "none",
  async run({ workspace }: { workspace: string }) {
    const task = await readFile(join(workspace, "README.md"), "utf8");
    const failing = process.env.SEVRO_RECIPE_FAIL === "1";
    if (task.includes("Fix add")) {
      await writeFile(
        join(workspace, "math.cjs"),
        `exports.add = (a, b) => a ${failing ? "-" : "+"} b;\n`,
      );
    }
    return {
      finalMessage: failing
        ? "Start with npm start on port 9000."
        : "Run bun run dev on port 3000.",
      complete: true,
    };
  },
};
export default host;
