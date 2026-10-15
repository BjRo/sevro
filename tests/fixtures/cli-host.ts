import type { HostAdapter } from "../../src/engine";

export default {
  id: "sevro.host.quality",
  model: "synthetic",
  effort: "none",
  run: () =>
    Promise.reject(new Error("Invalid CLI inputs must never execute the host")),
} satisfies HostAdapter;
