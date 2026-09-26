import type { HostAdapter } from "../../src/engine";

const host: HostAdapter = {
  id: "sevro.host.semantic-synthetic",
  model: "semantic-v1",
  effort: "low",
  async run({ prompt }) {
    if (!prompt.includes("response promises readiness"))
      throw new Error("semantic prompt omitted the proposition");
    const scenario = process.env.SEVRO_TEST_SCENARIO;
    return {
      finalMessage:
        scenario === "semantic-malformed"
          ? "invalid"
          : JSON.stringify({
              checks: [
                {
                  id: "semantic-ready",
                  verdict: scenario === "semantic-fail" ? "fail" : "pass",
                  reason: "Synthetic semantic assessment",
                },
              ],
            }),
      complete: true,
    };
  },
};

export default host;
