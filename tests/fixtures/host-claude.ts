#!/usr/bin/env bun
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
const mode = process.argv[process.argv.indexOf("-p") + 1] ?? "ready";
const config = process.env.CLAUDE_CONFIG_DIR;
if (!config) throw new Error("Missing synthetic Claude config");
const credential = join(config, ".credentials.json");
const saved = existsSync(credential);
const capture = {
  config,
  saved,
  permission: saved ? statSync(credential).mode & 0o777 : null,
  expectedLogin: saved
    ? readFileSync(credential, "utf8").includes("PRIVATE_TEST_LOGIN")
    : false,
  api: process.env.ANTHROPIC_API_KEY === "PRIVATE_API_KEY",
  oauth: process.env.CLAUDE_CODE_OAUTH_TOKEN === "PRIVATE_OAUTH_TOKEN",
  scrub: process.env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB,
  userRules: existsSync(join(config, "CLAUDE.md")),
  userSettings: existsSync(join(config, "settings.json")),
};
writeFileSync(
  join(process.cwd(), "authentication.json"),
  JSON.stringify(capture),
);
const session = "00000000-0000-4000-8000-000000000001";
const project = join(
  config,
  "projects",
  process.cwd().replace(/[^A-Za-z0-9]/g, "-"),
);
mkdirSync(project, { recursive: true });
function transcript(): string {
  const attachment = {
    type: "goal_status",
    condition: "PRIVATE_GOAL_OBJECTIVE🙂",
    met: true,
  };
  const variants: Record<string, unknown> = {
    "goal-active": { ...attachment, met: false },
    "goal-blocked": { ...attachment, failed: true },
    "goal-cleared": { ...attachment, sentinel: true },
    "goal-malformed": { ...attachment, met: "yes" },
    "goal-too-long": { ...attachment, condition: "x".repeat(4001) },
    "goal-no-objective": { ...attachment, condition: "" },
  };
  return (
    JSON.stringify({
      type: "attachment",
      sessionId: mode === "goal-foreign" ? "foreign" : session,
      attachment: variants[mode] ?? attachment,
      timestamp: "2026-10-08T00:00:00Z",
    }) + "\n"
  );
}
writeFileSync(join(project, `${session}.jsonl`), transcript());
if (mode === "goal-ambiguous") {
  mkdirSync(join(project, "other"));
  writeFileSync(join(project, "other", `${session}.jsonl`), transcript());
}
const send = (value: unknown) => {
  process.stdout.write(JSON.stringify(value) + "\n");
};
send({ type: "system", subtype: "init", session_id: session });
send({
  type: "result",
  subtype: "success",
  is_error: false,
  session_id: session,
  result: "ready",
  usage: { input_tokens: 1, output_tokens: 2 },
  total_cost_usd: 0,
});
