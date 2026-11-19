// Child-process entry for concurrent parent-owned refresh coverage. It stages
// one trial's authentication from the saved login and prints the staged token.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stageClaudeAuthentication } from "../../src/claude-login/index";

const [sourceFile, binary, lifetime] = process.argv.slice(2);
if (!sourceFile || !binary || !lifetime)
  throw new Error("usage: claude-access-token <login> <claude> <lifetime-ms>");
const root = await mkdtemp(join(tmpdir(), "sevro-claude-stage-"));
try {
  const staged = await stageClaudeAuthentication(
    join(root, "config"),
    sourceFile,
    { binary, lifetimeMs: Number(lifetime) },
  );
  process.stdout.write(staged.environment.CLAUDE_CODE_OAUTH_TOKEN ?? "");
} finally {
  await rm(root, { recursive: true, force: true });
}
