export const schemaNames = [
  "cli-result",
  "run-evidence",
  "report",
  "extension",
  "runtime",
] as const;

export const generatedValidators = schemaNames.map(
  (name) => `src/generated/${name}.cjs`,
);
