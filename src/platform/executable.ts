import { accessSync, constants, statSync } from "node:fs";
import { delimiter, resolve } from "node:path";

export function which(name: string, path?: string): string | null {
  for (const directory of executablePath(path).split(delimiter)) {
    const candidate = resolve(directory, name);
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      /* Continue searching the declared executable path. */
    }
  }
  return null;
}

function executablePath(path: string | undefined): string {
  return path ?? process.env.PATH ?? "";
}
