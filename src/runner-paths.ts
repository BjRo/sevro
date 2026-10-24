import { resolve, join } from "node:path";

export const sourceRuntime = import.meta.filename.endsWith(".ts");
export const runnerRoot = resolve(
  import.meta.dirname,
  sourceRuntime ? ".." : "../..",
);

export function examplePath(...parts: string[]): string {
  const path = join(
    runnerRoot,
    ...(sourceRuntime ? [] : ["dist"]),
    "examples",
    ...parts,
  );
  return runtimeModule(path);
}

export function runtimeModule(path: string): string {
  return sourceRuntime ? path : path.replace(/\.ts$/, ".js");
}
