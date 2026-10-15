/** Deterministic starter; replace with an explicit native route to evaluate a model. */
export default {
  id: "template.response",
  model: "deterministic-example",
  effort: "none",
  run() {
    return Promise.resolve({
      finalMessage: process.env.SEVRO_TEMPLATE_FAIL === "1" ? "wrong" : "ready",
      complete: true,
    });
  },
};
