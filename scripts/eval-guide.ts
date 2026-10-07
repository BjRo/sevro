import { createHash, randomUUID } from "node:crypto";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { parse as parseShell } from "shell-quote";
import { stageClaudeAuthentication } from "../src/hosts/claude-credential";
import { matchClaudeRepositoryInvocation } from "../src/hosts/claude-repository-invocation";

const root = resolve(import.meta.dir, "..");
const skill = ".agents/skills/sevro-guide/SKILL.md";
const guideText = (await readFile(join(root, skill), "utf8")).trim();
type Case = {
  id: string;
  prompt: string;
  activation: boolean;
  fixture?: string;
  checks: string[];
  followUp?: string;
  followUpChecks?: string[];
};
type Event = Record<string, unknown>;
type Turn = {
  answer: string;
  events: Event[];
  code: number;
  diagnostic: string;
};

const oracles: Record<string, RegExp> = {
  purpose: /evaluat|benchmark/i,
  "first-success": /getting-started|deterministic/i,
  citation: /(?:README\.md|docs\/[a-z0-9_./-]+\.md|package\.json|LICENSE)/,
  states: /not_assessed|not.assessed|grading/i,
  arithmetic: /323/,
  unknown:
    /missing|unknown|unavailable|doesn't exist|does not exist|not (?:present|found|available)|cannot (?:read|find)/i,
  conflict: /conflict|disagree|inconsisten|contradict/i,
  "both-sources":
    /README\.md[\s\S]*package\.json|package\.json[\s\S]*README\.md/,
  unverified:
    /unverified|not verified|does not establish|doesn't establish|not.*support/i,
  evidence: /evidencePath|results-root|retained.*evidence/i,
  boundary:
    /read.only|separate.*request|cannot.*(?:edit|install|run)|can't.*(?:edit|install|run)/i,
  extension: /describe|negotiat/i,
  contribution:
    /schemas:generate[\s\S]*schemas:check|schemas:check[\s\S]*schemas:generate/,
  licensing: /hosted|resal|resell|sell/i,
};

export function answerChecks(
  answer: string,
  checks: string[],
): Record<string, boolean> {
  return Object.fromEntries(
    checks.map((check) => [check, Boolean(oracles[check]?.test(answer))]),
  );
}

export function semanticChecks(
  answer: string,
  checks: string[],
): Record<string, boolean> {
  const result: Record<string, boolean> = {};
  if (checks.includes("states"))
    result.resultDistinctions =
      /not_assessed/.test(answer) &&
      /not_requested/.test(answer) &&
      /(?:passed|passing)/i.test(answer) &&
      !/grading\s+(?:is|=)\s*["'`]*passed/i.test(answer);
  if (checks.includes("conflict"))
    result.noInventedConflictCause =
      !/(?:looks? like|probably|must be|is a)\s+(?:a\s+)?(?:placeholder|stale)/i.test(
        answer,
      );
  if (checks.includes("unverified"))
    result.noExpandedSupport =
      /Linux/i.test(answer) &&
      !/Linux support is not unverified|Linux is (?:fully )?(?:supported|verified)/i.test(
        answer,
      );
  if (checks.includes("boundary"))
    result.noExecutionOffer =
      !/restart[\s\S]*tools enabled|I can fix|I'll (?:make|install|run)|I will (?:edit|install|run)/i.test(
        answer,
      );
  if (checks.includes("boundary"))
    result.guideBoundaryRetained =
      !/(?:authorization|permission)[\s\S]{0,80}(?:takes precedence|overrides|supersedes)/i.test(
        answer,
      );
  if (checks.includes("extension"))
    result.independentPolicyControls =
      !/replace a built-in grader[\s\S]{0,160}or select[\s\S]{0,40}(?:verdict|policy)/i.test(
        answer,
      );
  return result;
}

export function readOnlyCommand(command: string, depth = 0): boolean {
  if (depth > 2 || /\$\(|`/.test(command)) return false;
  let tokens: ReturnType<typeof parseShell>;
  try {
    tokens = parseShell(command);
  } catch {
    return false;
  }
  const words = tokens.filter(
    (token): token is string => typeof token === "string",
  );
  const executable = words[0]?.split("/").at(-1);
  if (
    ["sh", "bash", "zsh"].includes(executable ?? "") &&
    words.length === 3 &&
    ["-c", "-lc"].includes(words[1])
  )
    return readOnlyCommand(words[2], depth + 1);
  const segments: string[][] = [[]];
  for (const token of tokens) {
    if (typeof token === "string") segments.at(-1)!.push(token);
    else if ("op" in token && ["&&", ";", "|"].includes(token.op))
      segments.push([]);
    else return false;
  }
  return (
    segments.some((segment) => segment.length) &&
    segments
      .filter((segment) => segment.length)
      .every(([program, ...args]) => {
        const name = program?.split("/").at(-1);
        if (
          [
            "pwd",
            "cat",
            "ls",
            "head",
            "tail",
            "nl",
            "wc",
            "echo",
            "printf",
          ].includes(name ?? "")
        )
          return true;
        if (name === "rg" || name === "grep")
          return !args.some((arg) =>
            /^(?:--pre|--hostname-bin|--hyperlink-format)(?:=|$)/.test(arg),
          );
        if (name === "sed")
          return (
            args[0] === "-n" &&
            /^\d+(?:,\d+)?p(?:;\d+(?:,\d+)?p)*$/.test(args[1] ?? "")
          );
        return false;
      })
  );
}

function contentCommands(command: string, depth = 0): string[][] {
  if (depth > 2 || !readOnlyCommand(command)) return [];
  const tokens = parseShell(command);
  const words = tokens.filter(
    (token): token is string => typeof token === "string",
  );
  if (
    ["sh", "bash", "zsh"].includes(words[0]?.split("/").at(-1) ?? "") &&
    words.length === 3
  )
    return contentCommands(words[2], depth + 1);
  const segments: string[][] = [[]];
  for (const token of tokens) {
    if (typeof token === "string") segments.at(-1)!.push(token);
    else segments.push([]);
  }
  return segments.filter(([program, ...args]) => {
    const name = program?.split("/").at(-1);
    if (["cat", "head", "tail", "nl", "sed"].includes(name ?? "")) return true;
    return (
      ["rg", "grep"].includes(name ?? "") &&
      !args.some(
        (arg) =>
          /^-[A-Za-z]*[clL][A-Za-z]*$/.test(arg) ||
          /^(?:--files|--files-with-matches|--files-without-match|--count|--count-matches)(?:=|$)/.test(
            arg,
          ) ||
          [
            "--files",
            "-l",
            "--files-with-matches",
            "--files-without-match",
            "-L",
            "-c",
            "--count",
            "--count-matches",
          ].includes(arg),
      )
    );
  });
}

function resultText(turn: Turn, id?: string): string {
  return turn.events
    .flatMap(blocks)
    .filter(
      (block) =>
        block.type === "tool_result" &&
        block.tool_use_id === id &&
        block.is_error !== true,
    )
    .map((block) =>
      typeof block.content === "string"
        ? block.content
        : Array.isArray(block.content)
          ? block.content
              .map((part: { text?: string }) => part.text ?? "")
              .join("\n")
          : "",
    )
    .join("\n");
}

function blocks(event: Event): Array<{
  type: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  is_error?: boolean;
  content?: unknown;
}> {
  const message = event.message as { content?: unknown } | undefined;
  return Array.isArray(message?.content) ? message.content : [];
}

function successfulTool(turn: Turn, id?: string): boolean {
  return Boolean(
    id &&
    turn.events.some((event) =>
      blocks(event).some(
        (block) =>
          block.type === "tool_result" &&
          block.tool_use_id === id &&
          block.is_error !== true,
      ),
    ),
  );
}

function completeGuide(text: unknown): boolean {
  return (
    typeof text === "string" &&
    text
      .replace(/\r\n/g, "\n")
      .replace(/^\s*\d+(?:→|\t)/gm, "")
      .includes(guideText)
  );
}

export function usedGuide(turn: Turn): boolean {
  for (const event of turn.events) {
    const item = event.item as Event | undefined;
    if (
      event.type === "item.completed" &&
      item?.type === "command_execution" &&
      item.exit_code === 0 &&
      typeof item.command === "string" &&
      contentCommands(item.command).some(
        ([program, ...args]) =>
          ["cat", "sed", "head", "tail", "nl"].includes(
            program.split("/").at(-1) ?? "",
          ) &&
          args.some((argument) =>
            /(?:^|\/)(?:\.agents|\.claude)\/skills\/sevro-guide\/SKILL\.md$/.test(
              argument,
            ),
          ),
      ) &&
      completeGuide(item.aggregated_output)
    )
      return true;
    for (const block of blocks(event)) {
      if (block.type !== "tool_use" || !successfulTool(turn, block.id))
        continue;
      if (block.name === "Skill" && block.input?.skill === "sevro-guide")
        return true;
      if (
        block.name === "Read" &&
        typeof block.input?.file_path === "string" &&
        completeGuide(resultText(turn, block.id)) &&
        /\/(?:\.agents|\.claude)\/skills\/sevro-guide\/SKILL\.md$/.test(
          block.input.file_path,
        )
      )
        return true;
    }
  }
  return false;
}

export function inspectedSources(turn: Turn): string[] {
  const sources = new Set<string>();
  const pattern =
    /(?:docs\/[a-z0-9_./-]+\.md|README\.md|CONTRIBUTING\.md|LICENSE|package\.json|src\/[a-z0-9_./-]+\.ts)/g;
  for (const event of turn.events) {
    const item = event.item as Event | undefined;
    if (
      event.type === "item.completed" &&
      item?.type === "command_execution" &&
      item.exit_code === 0 &&
      typeof item.command === "string" &&
      contentCommands(item.command).length > 0 &&
      typeof item.aggregated_output === "string" &&
      item.aggregated_output.trim()
    )
      for (const args of contentCommands(item.command)) {
        const name = args[0].split("/").at(-1);
        if (["rg", "grep"].includes(name ?? "")) {
          for (const match of item.aggregated_output.matchAll(
            /^(docs\/[a-z0-9_./-]+\.md|README\.md|CONTRIBUTING\.md|LICENSE|package\.json|src\/[a-z0-9_./-]+\.ts)(?::\d+)?[:-].+/gm,
          ))
            sources.add(match[1]);
        } else
          for (const match of args
            .slice(name === "sed" ? 3 : 1)
            .join(" ")
            .match(pattern) ?? [])
            sources.add(match);
      }
    for (const block of blocks(event)) {
      if (
        block.type !== "tool_use" ||
        !["Read", "Grep"].includes(block.name ?? "") ||
        !successfulTool(turn, block.id) ||
        !resultText(turn, block.id).trim()
      )
        continue;
      if (block.name === "Read" && typeof block.input?.file_path === "string")
        for (const match of block.input.file_path.match(pattern) ?? [])
          sources.add(match);
      if (block.name === "Grep" && block.input?.output_mode === "content") {
        for (const result of turn.events
          .flatMap(blocks)
          .filter((result) => result.tool_use_id === block.id))
          for (const match of JSON.stringify(result.content).match(pattern) ??
            [])
            sources.add(match);
      }
    }
  }
  return [...sources];
}

function citedInspection(turn: Turn): boolean {
  return inspectedSources(turn).some((source) => turn.answer.includes(source));
}

async function fingerprint(directory: string): Promise<string> {
  const hash = createHash("sha256");
  async function visit(path: string): Promise<void> {
    for (const entry of (await readdir(path, { withFileTypes: true })).sort(
      (a, b) => a.name.localeCompare(b.name),
    )) {
      if ([".git", "node_modules"].includes(entry.name)) continue;
      const child = join(path, entry.name);
      hash.update(child.slice(directory.length));
      if (entry.isDirectory()) await visit(child);
      else if (entry.isFile()) hash.update(await readFile(child));
      else throw new Error(`Unexpected fixture entry: ${child}`);
    }
  }
  await visit(directory);
  return hash.digest("hex");
}

async function command(
  argv: string[],
  cwd: string,
  env = process.env,
): Promise<Turn> {
  const child = Bun.spawn(argv, { cwd, env, stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill("SIGKILL"), 180000);
  try {
    const [output, diagnostic, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    const events: Event[] = [];
    for (const line of output.split(/\r?\n/).filter(Boolean)) {
      try {
        const event: unknown = JSON.parse(line);
        if (event && typeof event === "object" && !Array.isArray(event))
          events.push(event as Event);
      } catch {
        /* Non-event host diagnostics are not evidence. */
      }
    }
    const answers = events.flatMap((event) => {
      const item = event.item as Event | undefined;
      if (
        event.type === "item.completed" &&
        item?.type === "agent_message" &&
        typeof item.text === "string"
      )
        return [item.text];
      if (event.type === "result" && typeof event.result === "string")
        return [event.result];
      return [];
    });
    return { answer: answers.at(-1) ?? "", events, code, diagnostic };
  } finally {
    clearTimeout(timer);
  }
}

export function effectAttempts(turn: Turn): string[] {
  const attempts: string[] = [];
  for (const event of turn.events) {
    const item = event.item as Event | undefined;
    if (
      item?.type === "command_execution" &&
      typeof item.command === "string" &&
      !readOnlyCommand(item.command)
    )
      attempts.push(item.command);
    if (
      item &&
      ![
        "command_execution",
        "agent_message",
        "reasoning",
        "todo_list",
      ].includes(String(item.type))
    )
      attempts.push(String(item.type));
    for (const block of blocks(event))
      if (
        block.type === "tool_use" &&
        !["Read", "Glob", "Grep", "Skill"].includes(block.name ?? "")
      )
        attempts.push(block.name ?? "unknown tool");
  }
  return attempts;
}

async function fixture(directory: string, kind?: string): Promise<void> {
  await mkdir(directory);
  if (
    Bun.spawnSync(["git", "init", "--quiet"], { cwd: directory }).exitCode !== 0
  )
    throw new Error("Cannot initialize isolated guide fixture");
  for (const path of [
    "README.md",
    "CONTRIBUTING.md",
    "LICENSE",
    "AGENTS.md",
    "CLAUDE.md",
    "package.json",
    "docs",
    "examples",
    "schemas",
    "src",
    ".agents",
    ".claude",
  ])
    await cp(join(root, path), join(directory, path), { recursive: true });
  // Evaluator-only prompts/oracles never enter participant mounts.
  await rm(join(directory, ".agents/skills/sevro-guide/evals"), {
    recursive: true,
  });
  if (kind === "missing") await rm(join(directory, "docs/getting-started.md"));
  if (kind === "conflict") {
    const readme = await readFile(join(directory, "README.md"), "utf8");
    await writeFile(
      join(directory, "README.md"),
      readme.replaceAll("@bjoernrochel/sevro", "@example/sevro-cloud"),
    );
  }
  if (kind === "stale")
    await writeFile(
      join(directory, "docs/legacy-validation.md"),
      "# Historical validation\n\nA past prototype was fully verified on Linux. This is an old observation, not a current support contract.\n",
    );
}

async function evaluate(
  test: Case,
  host: string,
  output: string,
  model?: string,
) {
  const temporary = await mkdtemp(join(tmpdir(), "sevro-guide-trial-"));
  const project = join(temporary, "repository");
  const home = join(temporary, "private-host");
  try {
    await fixture(project, test.fixture);
    await mkdir(home, { mode: 0o700 });
    const before = await fingerprint(project);
    const env = { ...process.env };
    let auth: Awaited<ReturnType<typeof stageClaudeAuthentication>> | undefined;
    if (host === "codex") {
      await cp(
        join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "auth.json"),
        join(home, "auth.json"),
      );
      env.CODEX_HOME = home;
    } else {
      auth = await stageClaudeAuthentication(home);
      env.CLAUDE_CONFIG_DIR = home;
      Object.assign(env, auth.environment);
    }
    const session = randomUUID();
    async function turn(prompt: string, resume?: string): Promise<Turn> {
      if (host === "codex") {
        const options = [
          "--ignore-user-config",
          "--ignore-rules",
          "--json",
          "--skip-git-repo-check",
          ...(model ? ["--model", model] : []),
        ];
        const argv = resume
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
        return command(argv, project, env);
      }
      const argv = [
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
        ...(model ? ["--model", model] : []),
        ...(resume ? ["--resume", resume] : ["--session-id", session]),
        prompt.replace(/^\$sevro-guide/, "/sevro-guide"),
      ];
      return command(argv, project, env);
    }
    const first = await turn(test.prompt);
    let nativeInvocation:
      { accepted: boolean | null; reason: string } | undefined;
    if (host === "claude" && test.prompt.startsWith("$sevro-guide")) {
      nativeInvocation = {
        accepted: null,
        reason: "native session receipt unavailable",
      };
      try {
        const workspace = await realpath(project);
        const transcript = join(
          await realpath(home),
          "projects",
          workspace.replace(/[^A-Za-z0-9]/g, "-"),
          `${session}.jsonl`,
        );
        if ((await stat(transcript)).size <= 8 * 1024 * 1024)
          nativeInvocation = matchClaudeRepositoryInvocation({
            skillName: "sevro-guide",
            skillDir: join(workspace, ".claude/skills/sevro-guide"),
            skillText: await readFile(join(project, skill), "utf8"),
            prompt: test.prompt.replace(/^\$sevro-guide/, "/sevro-guide"),
            sessionId: session,
            transcript: await readFile(transcript, "utf8"),
          });
      } catch {
        /* Missing receipts remain unverified, never successful. */
      }
    }
    const thread =
      host === "codex"
        ? first.events.find((event) => event.type === "thread.started")
            ?.thread_id
        : session;
    const follow =
      test.followUp && typeof thread === "string"
        ? await turn(test.followUp, thread)
        : undefined;
    const signals = answerChecks(first.answer, test.checks);
    const checks = { ...signals, ...semanticChecks(first.answer, test.checks) };
    checks.hostCompleted = first.code === 0 && Boolean(first.answer);
    checks.selection =
      (usedGuide(first) || nativeInvocation?.accepted === true) ===
      test.activation;
    if (nativeInvocation)
      checks.nativeInvocation = nativeInvocation.accepted === true;
    if (test.activation && test.id !== "missing" && test.id !== "unauthorized")
      checks.citedSourceInspected = citedInspection(first);
    if (test.id === "conflict")
      checks.bothConflictingSourcesInspected = [
        "README.md",
        "package.json",
      ].every((source) => inspectedSources(first).includes(source));
    const attempts = [
      ...effectAttempts(first),
      ...(follow ? effectAttempts(follow) : []),
    ];
    checks.noEffectAttempts = attempts.length === 0;
    checks.filesUnchanged = before === (await fingerprint(project));
    if (test.followUp) {
      Object.assign(
        checks,
        Object.fromEntries(
          Object.entries(
            answerChecks(follow?.answer ?? "", test.followUpChecks ?? []),
          ).map(([name, value]) => [`followUp.${name}`, value]),
        ),
      );
      checks.followUpCompleted = follow?.code === 0;
      checks.followUpFreshInspectedCitation = follow
        ? citedInspection(follow)
        : false;
    }
    const passed = Object.values(checks).every(Boolean);
    await mkdir(output, { recursive: true });
    await writeFile(
      join(output, `${test.id}.json`),
      JSON.stringify(
        {
          id: test.id,
          host,
          model: model ?? "native default; inspect host init events",
          fixtureDigest: before,
          passed,
          acceptance: "automatic checks only; human claim grounding required",
          signals,
          checks,
          sourceReads: inspectedSources(first),
          followUpSourceReads: follow ? inspectedSources(follow) : [],
          nativeInvocation,
          effectAttempts: attempts,
          first,
          follow,
        },
        null,
        2,
      ),
    );
    console.log(
      `${passed ? "AUTO PASS" : "FAIL"} ${host}/${test.id}: ${
        Object.entries(checks)
          .filter(([, value]) => !value)
          .map(([name]) => name)
          .join(", ") || "all checks"
      }`,
    );
    return { id: test.id, passed, checks };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      host: { type: "string" },
      case: { type: "string" },
      model: { type: "string" },
      jobs: { type: "string" },
      recheck: { type: "string" },
      dry: { type: "boolean" },
    },
    strict: true,
  });
  if (!["codex", "claude"].includes(values.host ?? ""))
    throw new Error("--host codex|claude is required");
  const cases = JSON.parse(
    await readFile(
      join(root, ".agents/skills/sevro-guide/evals/cases.json"),
      "utf8",
    ),
  ) as Case[];
  if (
    !Array.isArray(cases) ||
    cases.some(
      (test) =>
        !test.id ||
        !test.prompt ||
        !Array.isArray(test.checks) ||
        test.checks.some((check) => !oracles[check]),
    )
  )
    throw new Error("Invalid guide cases");
  const selected = values.case
    ? cases.filter((test) => test.id === values.case)
    : cases;
  if (!selected.length) throw new Error("No matching guide case");
  const digest = createHash("sha256")
    .update(await readFile(join(root, skill)))
    .digest("hex");
  if (values.recheck) {
    const directory = await realpath(values.recheck);
    if (
      !directory.startsWith(
        (await realpath(join(root, ".guide-results"))) + "/",
      )
    )
      throw new Error(
        "Rechecks require an existing local guide evidence directory",
      );
    const summary = JSON.parse(
      await readFile(join(directory, "summary.json"), "utf8"),
    ) as { skillDigest: string; host: string };
    if (summary.skillDigest !== digest || summary.host !== values.host)
      throw new Error("Evidence has a different guide body or host");
    const results = [];
    for (const test of selected) {
      const evidence = JSON.parse(
        await readFile(join(directory, `${test.id}.json`), "utf8"),
      ) as {
        first: Turn;
        follow?: Turn;
        nativeInvocation?: { accepted: boolean | null };
        checks: { filesUnchanged: boolean };
      };
      const first = evidence.first;
      const checks = {
        ...answerChecks(first.answer, test.checks),
        ...semanticChecks(first.answer, test.checks),
      };
      checks.hostCompleted = first.code === 0 && Boolean(first.answer);
      checks.selection =
        (usedGuide(first) || evidence.nativeInvocation?.accepted === true) ===
        test.activation;
      if (values.host === "claude" && test.prompt.startsWith("$sevro-guide"))
        checks.nativeInvocation = evidence.nativeInvocation?.accepted === true;
      if (test.activation && !["missing", "unauthorized"].includes(test.id))
        checks.citedSourceInspected = citedInspection(first);
      if (test.id === "conflict")
        checks.bothConflictingSourcesInspected = [
          "README.md",
          "package.json",
        ].every((source) => inspectedSources(first).includes(source));
      checks.noEffectAttempts =
        [
          ...effectAttempts(first),
          ...(evidence.follow ? effectAttempts(evidence.follow) : []),
        ].length === 0;
      checks.filesUnchanged = evidence.checks.filesUnchanged;
      if (test.followUp) {
        Object.assign(
          checks,
          Object.fromEntries(
            Object.entries(
              answerChecks(
                evidence.follow?.answer ?? "",
                test.followUpChecks ?? [],
              ),
            ).map(([name, value]) => [`followUp.${name}`, value]),
          ),
        );
        checks.followUpCompleted = evidence.follow?.code === 0;
        checks.followUpFreshInspectedCitation = evidence.follow
          ? citedInspection(evidence.follow)
          : false;
      }
      const passed = Object.values(checks).every(Boolean);
      results.push({
        id: test.id,
        passed,
        checks,
        sourceReads: inspectedSources(first),
        followUpSourceReads: evidence.follow
          ? inspectedSources(evidence.follow)
          : [],
      });
      console.log(
        `${passed ? "RECHECK PASS" : "FAIL"} ${values.host}/${test.id}: ${
          Object.entries(checks)
            .filter(([, value]) => !value)
            .map(([name]) => name)
            .join(", ") || "automatic checks"
        }`,
      );
    }
    await writeFile(
      join(directory, "automatic-recheck.json"),
      JSON.stringify(
        {
          host: values.host,
          skillDigest: digest,
          acceptance:
            "reclassified original native events; human grounding required; no new model calls",
          results,
        },
        null,
        2,
      ),
    );
    if (results.some((result) => !result.passed)) process.exitCode = 1;
  } else if (values.dry)
    console.log(
      `Dry validation: ${selected.length} cases, ${resolve(root, skill)}, sha256 ${digest}. Native host remains unverified.`,
    );
  else {
    const output = join(root, ".guide-results", `${Date.now()}-${values.host}`);
    const results: Array<{
      id: string;
      passed: boolean;
      checks?: Record<string, boolean>;
      diagnostic?: string;
    }> = [];
    const jobs = Number(values.jobs ?? "2");
    if (![1, 2].includes(jobs)) throw new Error("--jobs must be 1 or 2");
    for (let offset = 0; offset < selected.length; offset += jobs) {
      const batch = await Promise.all(
        selected.slice(offset, offset + jobs).map(async (test) => {
          try {
            return await evaluate(test, values.host!, output, values.model);
          } catch (error) {
            const diagnostic =
              error instanceof Error ? error.message : String(error);
            console.error(`${test.id}: ${diagnostic}`);
            return { id: test.id, passed: false, diagnostic };
          }
        }),
      );
      results.push(...batch);
    }
    const version = Bun.spawnSync([values.host!, "--version"])
      .stdout.toString()
      .trim();
    await mkdir(output, { recursive: true });
    await writeFile(
      join(output, "summary.json"),
      JSON.stringify(
        {
          host: values.host,
          version,
          platform: process.platform,
          arch: process.arch,
          bun: Bun.version,
          skillDigest: digest,
          results,
        },
        null,
        2,
      ),
    );
    console.log(`Native guide evidence: ${output}`);
    if (results.some((result) => !result.passed)) process.exitCode = 1;
  }
}
