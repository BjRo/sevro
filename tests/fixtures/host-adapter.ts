import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { HostAdapter } from "../../src/engine";

const host: HostAdapter = {
  id: "sevro.host.synthetic",
  model: "synthetic-v1",
  effort: "none",
  async run({ workspace }) {
    await readFile(join(workspace, "README.md"), "utf8");
    return {
      finalMessage:
        process.env.SEVRO_TEST_SCENARIO === "fail" ? "wait" : "ready",
      complete: true,
      inputTokens: null,
      outputTokens: null,
      costUsd: null,
      usageComplete: false,
    };
  },
};

export default host;
