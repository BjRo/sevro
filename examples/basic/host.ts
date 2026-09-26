export default {
  id: "sevro.host.example",
  model: "deterministic-example",
  effort: "none",
  async run() {
    return { finalMessage: "ready", complete: true };
  },
};
