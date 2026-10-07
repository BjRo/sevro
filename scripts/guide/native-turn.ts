import { isRecord } from "../../src/value-guards";
import type { GuideEvent, Host, Turn } from "./types";

function parseEvents(output: string): GuideEvent[] {
  const events: GuideEvent[] = [];
  for (const line of output.split(/\r?\n/).filter(Boolean)) {
    try {
      const value: unknown = JSON.parse(line);
      if (isRecord(value)) events.push(value);
    } catch {
      /* Non-event diagnostics are not evidence. */
    }
  }
  return events;
}

function agentMessage(event: GuideEvent): string | undefined {
  if (event.type !== "item.completed") return undefined;
  if (!isRecord(event.item)) return undefined;
  const item = event.item;
  if (item.type === "agent_message" && typeof item.text === "string")
    return item.text;
  return undefined;
}
function eventAnswers(event: GuideEvent): string[] {
  const text = agentMessage(event);
  if (text !== undefined) return [text];
  return event.type === "result" && typeof event.result === "string"
    ? [event.result]
    : [];
}

export async function nativeCommand(
  argv: string[],
  cwd: string,
  env = process.env,
): Promise<Turn> {
  const child = Bun.spawn(argv, { cwd, env, stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => {
    child.kill("SIGKILL");
  }, 180000);
  try {
    const [output, diagnostic, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    const events = parseEvents(output),
      answers = events.flatMap(eventAnswers);
    return { answer: answers.at(-1) ?? "", events, code, diagnostic };
  } finally {
    clearTimeout(timer);
  }
}

function codexArguments(
  project: string,
  prompt: string,
  model: string | undefined,
  resume: string | undefined,
): string[] {
  const options = [
    "--ignore-user-config",
    "--ignore-rules",
    "--json",
    "--skip-git-repo-check",
    ...modelOption(model),
  ];
  return resume
    ? ["codex", "exec", "resume", ...options, resume, prompt]
    : [
        "codex",
        "exec",
        ...options,
        "--sandbox",
        "read-only",
        "-C",
        project,
        prompt,
      ];
}

function modelOption(model: string | undefined): string[] {
  return model ? ["--model", model] : [];
}

function claudeArguments(
  prompt: string,
  model: string | undefined,
  session: string,
  resume: string | undefined,
): string[] {
  return [
    "claude",
    "--print",
    "--output-format",
    "stream-json",
    "--verbose",
    "--setting-sources",
    "project",
    "--strict-mcp-config",
    "--mcp-config",
    '{"mcpServers":{}}',
    "--settings",
    '{"disableAllHooks":true,"permissions":{"deny":["Edit","Write","Bash","Agent","WebFetch","WebSearch"]}}',
    "--tools",
    "Read,Glob,Grep,Skill",
    "--allowedTools",
    "Read,Glob,Grep,Skill",
    "--permission-prompts",
    "none",
    ...modelOption(model),
    ...sessionOption(session, resume),
    prompt.replace(/^\$sevro-guide/, "/sevro-guide"),
  ];
}

function sessionOption(session: string, resume: string | undefined): string[] {
  return resume ? ["--resume", resume] : ["--session-id", session];
}

export function runGuideTurn(
  host: Host,
  project: string,
  prompt: string,
  env: NodeJS.ProcessEnv,
  session: string,
  model?: string,
  resume?: string,
): Promise<Turn> {
  const args =
    host === "codex"
      ? codexArguments(project, prompt, model, resume)
      : claudeArguments(prompt, model, session, resume);
  return nativeCommand(args, project, env);
}
