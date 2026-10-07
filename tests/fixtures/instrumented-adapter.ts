import type { HostAdapter } from "../../src/engine";
const adapter: HostAdapter = {
  id: "sevro.host.instrumented",
  model: "synthetic-v1",
  effort: "none",
  instrumentation: [
    { id: "example.extension.guard", executionChanging: true },
    { id: "example.extension.trace", executionChanging: false },
  ],
  run({ condition, instrumentation }) {
    return Promise.resolve({
      finalMessage: "ready",
      complete: true,
      actualCondition: condition,
      appliedInstrumentation: instrumentation ?? [],
    });
  },
};
export default adapter;
