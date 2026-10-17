import { writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Deterministic file editor; it exercises the evaluator, not model coding ability. */
export default {
  id: "template.coding",
  model: "deterministic-editor",
  effort: "none",
  async run({ workspace }: { workspace: string }) {
    if (process.env.SEVRO_TEMPLATE_FAIL !== "1")
      await writeFile(
        join(workspace, "add.sh"),
        'add() { echo "$(( $1 + $2 ))"; }\n',
      );
    return { finalMessage: "Completed the coding task.", complete: true };
  },
};
