/** Protocol control only: use a real judge for qualitative model assessment. */
const judge = {
  id: "recipes.protocol-judge",
  model: "exact-fixture-oracle",
  effort: "none",
  run({ prompt }: { prompt: string }) {
    const match =
      /<candidate-response-json>\s*([\s\S]*?)\s*<\/candidate-response-json>/.exec(
        prompt,
      );
    if (!match?.[1]) throw new Error("Missing semantic candidate response");
    const candidate: unknown = JSON.parse(match[1]);
    const passed = candidate === "Run bun run dev on port 3000.";
    return Promise.resolve({
      complete: true,
      finalMessage: JSON.stringify({
        checks: [
          {
            id: "startup-meaning",
            verdict: passed ? "pass" : "fail",
            reason:
              "Exact deterministic fixture oracle; no model judgment was made.",
          },
        ],
      }),
    });
  },
};
export default judge;
