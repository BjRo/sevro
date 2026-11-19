import { isAbsolute, relative, sep } from "node:path";

/** Lexical containment includes the root itself; callers resolve symlinks first. */
export function insideRoot(root: string, path: string): boolean {
  const child = relative(root, path);
  return (
    child === "" ||
    (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child))
  );
}

/** Keep outermost roots in input order, retaining the first equivalent spelling. */
export function minimalRoots(roots: string[]): string[] {
  return roots.filter(
    (root, index) =>
      !roots.some(
        (other, otherIndex) =>
          insideRoot(other, root) &&
          (!insideRoot(root, other) || otherIndex < index),
      ),
  );
}
