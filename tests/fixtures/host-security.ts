// Synthetic macOS `security` for Keychain tests: one item, backed by a file.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { syntheticClaudeLogin } from "./claude-login";

const [mode = "success", marker, store = "", ...command] =
  process.argv.slice(2);
if (marker) writeFileSync(marker, String(process.pid));

function storedItem(): string {
  if (store && existsSync(store)) return readFileSync(store, "utf8");
  return syntheticClaudeLogin({
    expiresInMs: mode.startsWith("expired") ? -60_000 : undefined,
  });
}

const findOutputs: Record<string, () => void> = {
  failure: () => process.exit(1),
  missing: () => process.exit(44),
  slow: () =>
    setInterval(() => {
      process.stdout.write("");
    }, 1000),
  oversized: () => process.stdout.write(Buffer.alloc(1024 * 1024 + 1, "x")),
  whitespace: () => process.stdout.write(" \n\t"),
  empty: () => undefined,
};

function find(): void {
  const output = findOutputs[mode];
  if (output) output();
  else process.stdout.write(`${storedItem()}\n`);
}

/** Accept Claude Code's update form: `add-generic-password ... -X <hex>`. */
function update(words: string[]): void {
  const hex = words[words.indexOf("-X") + 1];
  if (mode.endsWith("readonly") || !hex) process.exit(1);
  // An accepted update that is not applied must not count as persistence.
  if (mode.endsWith("ignored")) return;
  writeFileSync(store, Buffer.from(hex, "hex"));
}

if (command[0] === "find-generic-password") find();
else if (command[0] === "add-generic-password") update(command);
else if (command[0] === "-i") {
  const line = readFileSync(0, "utf8");
  update(
    line
      .trim()
      .split(" ")
      .map((word) => word.replaceAll('"', "")),
  );
} else process.exit(2);
