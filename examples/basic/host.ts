export default {
  id: "sevro.host.example",
  model: "deterministic-example",
  effort: "none",
  run() {
    return Promise.resolve({ finalMessage: "ready", complete: true });
  },
};
