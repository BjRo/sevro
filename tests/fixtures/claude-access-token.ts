// Child-process entry for concurrent parent-owned refresh coverage.
import { claudeAccessToken } from "../../src/hosts/claude-credential";

const [sourceFile, binary, lifetime] = process.argv.slice(2);
if (!sourceFile || !binary || !lifetime)
  throw new Error("usage: claude-access-token <login> <claude> <lifetime-ms>");
process.stdout.write(
  await claudeAccessToken(sourceFile, {
    binary,
    lifetimeMs: Number(lifetime),
  }),
);
