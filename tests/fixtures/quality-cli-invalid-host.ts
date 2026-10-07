const base = {
  id: "synthetic",
  model: "synthetic",
  effort: "none",
  run: () => Promise.reject(new Error("Invalid adapter must never execute")),
};
const variants: Record<string, unknown> = {
  id: { ...base, id: 42 },
  model: { ...base, model: null },
  effort: { ...base, effort: false },
  run: { ...base, run: "not a callable" },
  instrumentation: {
    ...base,
    instrumentation: [{ id: "unnamespaced", executionChanging: false }],
  },
  capabilityType: { ...base, hostCapabilities: [42] },
  capabilityNamespace: { ...base, hostCapabilities: ["unnamespaced"] },
  capabilityDuplicate: {
    ...base,
    hostCapabilities: ["example.repeat", "example.repeat"],
  },
};
const selected = process.env.SEVRO_QUALITY_INVALID_ADAPTER;
if (!selected || !Object.hasOwn(variants, selected))
  throw new Error("Missing invalid adapter fixture selection");
const value: unknown = variants[selected];
export default value;
