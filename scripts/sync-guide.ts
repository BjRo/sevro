import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const source = resolve(root, ".agents/skills/sevro-guide/SKILL.md");
const target = resolve(root, ".claude/skills/sevro-guide/SKILL.md");
await writeFile(target, await readFile(source));
console.log(`Synchronized ${source} -> ${target}`);
