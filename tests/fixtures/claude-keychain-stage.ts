// Child-process entry staging Claude authentication from the default
// configuration's synthetic Keychain item. The default configuration and the
// private state root derive from HOME and TMPDIR at startup, so the parent
// isolates both before this process starts.
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stageClaudeAuthentication } from "../../src/claude-login/index";
import { withSyntheticKeychain } from "./host-auth";

const [mode, account] = process.argv.slice(2);
if (!mode || !account)
  throw new Error("usage: claude-keychain-stage <mode> <account>");
const root = await mkdtemp(join(tmpdir(), "sevro-claude-stage-"));
const staged = await withSyntheticKeychain(mode, account, () =>
  stageClaudeAuthentication(join(root, "config"), undefined, {
    binary: "/nonexistent/claude",
    lifetimeMs: 60_000,
  }),
);
process.stdout.write(JSON.stringify(staged.environment));
