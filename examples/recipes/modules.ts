import { join } from "node:path";

/** Locate source modules for Bun development or compiled modules for consumers. */
export function recipeFile(...parts: string[]): string {
  const path = join(import.meta.dirname, ...parts);
  return import.meta.filename.endsWith(".ts")
    ? path
    : path.replace(/\.ts$/, ".js");
}
