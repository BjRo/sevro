import { readFile, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import { matchClaudeRepositoryInvocation } from "../../src/hosts/claude-repository-invocation";
import { guidePath } from "./workspace";
import type { GuideCase, Host, NativeInvocation, Turn } from "./types";
import { runGuideTurn } from "./native-turn";

export async function nativeInvocation(
  host: Host,
  test: GuideCase,
  project: string,
  home: string,
  session: string,
): Promise<NativeInvocation | undefined> {
  if (host !== "claude" || !test.prompt.startsWith("$sevro-guide"))
    return undefined;
  const unavailable = {
    accepted: null,
    reason: "native session receipt unavailable",
  };
  try {
    return (await claudeReceipt(test, project, home, session)) ?? unavailable;
  } catch {
    return unavailable;
  }
}

async function claudeReceipt(
  test: GuideCase,
  project: string,
  home: string,
  session: string,
): Promise<NativeInvocation | undefined> {
  const workspace = await realpath(project);
  const transcript = join(
    await realpath(home),
    "projects",
    workspace.replace(/[^A-Za-z0-9]/g, "-"),
    `${session}.jsonl`,
  );
  if ((await stat(transcript)).size > 8 * 1024 * 1024) return undefined;
  return matchClaudeRepositoryInvocation({
    skillName: "sevro-guide",
    skillDir: join(workspace, ".claude/skills/sevro-guide"),
    skillText: await readFile(join(project, guidePath), "utf8"),
    prompt: test.prompt.replace(/^\$sevro-guide/, "/sevro-guide"),
    sessionId: session,
    transcript: await readFile(transcript, "utf8"),
  });
}

function thread(host: Host, first: Turn, session: string): unknown {
  return host === "codex"
    ? first.events.find((event) => event.type === "thread.started")?.thread_id
    : session;
}

export async function followUpTurn(
  test: GuideCase,
  host: Host,
  first: Turn,
  project: string,
  env: NodeJS.ProcessEnv,
  session: string,
  model: string | undefined,
): Promise<Turn | undefined> {
  const id = thread(host, first, session);
  return test.followUp && typeof id === "string"
    ? runGuideTurn(host, project, test.followUp, env, session, model, id)
    : undefined;
}
