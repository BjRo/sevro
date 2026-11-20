import { createReadStream, type Dirent } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { isRecord } from "../kernel/index";

const MAX_SESSION_ENTRIES = 1024;
const MAX_SESSION_BYTES = 64 * 1024 * 1024;
const THREAD_ID = /^[A-Za-z0-9._-]{1,128}$/;

type IncompleteReason =
  | "sessions_unavailable"
  | "sessions_incomplete"
  | "root_session_unavailable"
  | "session_unreadable"
  | "session_usage_missing";

interface TokenTotal {
  inputTokens: number;
  outputTokens: number;
}

interface SessionUsage {
  threadId: string | null;
  parentThreadId: string | null;
  usage: TokenTotal | null;
}

/** Measured thread-tree usage and the observation that states its scope. */
export interface CodexTreeUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  complete: boolean;
  observation: {
    id: "sevro.codex.usage";
    completeness: "complete" | "partial";
    data: {
      scope: "thread_tree";
      threads: number;
      rootInputTokens: number | null;
      rootOutputTokens: number | null;
      unlinkedSessions: number;
      incompleteReasons: IncompleteReason[];
    };
  };
}

function tokenCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function tokenTotal(value: unknown): TokenTotal | null {
  if (!isRecord(value)) return null;
  const { input_tokens: inputTokens, output_tokens: outputTokens } = value;
  return tokenCount(inputTokens) && tokenCount(outputTokens)
    ? { inputTokens, outputTokens }
    : null;
}

function addTotals(left: TokenTotal, right: TokenTotal): TokenTotal {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
  };
}

function decreased(previous: TokenTotal, next: TokenTotal): boolean {
  return (
    next.inputTokens < previous.inputTokens ||
    next.outputTokens < previous.outputTokens
  );
}

/**
 * A session's totals are cumulative. A decrease starts a new segment, as when
 * a resumed process restarts its count; each completed segment counts once.
 */
class SessionTotals {
  private closed: TokenTotal = { inputTokens: 0, outputTokens: 0 };
  private current: TokenTotal | null = null;

  observe(total: TokenTotal): void {
    if (this.current && decreased(this.current, total))
      this.closed = addTotals(this.closed, this.current);
    this.current = total;
  }

  usage(): TokenTotal | null {
    return this.current ? addTotals(this.closed, this.current) : null;
  }
}

function field(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

function sessionIdentity(entry: Record<string, unknown>) {
  if (entry.type !== "session_meta")
    return { threadId: null, parentThreadId: null };
  const meta = entry.payload;
  const id = field(meta, "id");
  const spawn = field(field(field(meta, "source"), "subagent"), "thread_spawn");
  const parent = field(spawn, "parent_thread_id");
  return {
    threadId: typeof id === "string" ? id : null,
    parentThreadId: typeof parent === "string" ? parent : null,
  };
}

/** Rate-limit-only counts carry no info; an invalid total is malformed. */
function tokenCountTotal(entry: Record<string, unknown>): TokenTotal | null {
  if (field(entry.payload, "type") !== "token_count") return null;
  const info = field(entry.payload, "info");
  if (info === null || info === undefined) return null;
  const total = tokenTotal(field(info, "total_token_usage"));
  if (total === null) throw new Error("Malformed Codex token count");
  return total;
}

function parsedEntry(line: string): Record<string, unknown> {
  const value: unknown = JSON.parse(line);
  if (!isRecord(value)) throw new Error("Malformed Codex session entry");
  return value;
}

/** Session identity comes from its first entry; usage from token counts. */
class SessionReader {
  private totals = new SessionTotals();
  private identity: Omit<SessionUsage, "usage"> | null = null;

  consume(line: string): void {
    if (!line.trim()) return;
    this.identity ??= sessionIdentity(parsedEntry(line));
    if (!line.includes('"token_count"')) return;
    const total = tokenCountTotal(parsedEntry(line));
    if (total) this.totals.observe(total);
  }

  session(): SessionUsage {
    const identity = this.identity ?? { threadId: null, parentThreadId: null };
    return { ...identity, usage: this.totals.usage() };
  }
}

/** Read session identity and usage without retaining private content. */
async function readSessionUsage(path: string): Promise<SessionUsage> {
  if ((await lstat(path)).size > MAX_SESSION_BYTES)
    throw new Error("Codex session exceeds limit");
  const reader = new SessionReader();
  const lines = createInterface({ input: createReadStream(path) });
  for await (const line of lines) reader.consume(line);
  return reader.session();
}

async function sessionsRootAvailable(root: string): Promise<boolean> {
  try {
    const entry = await lstat(root);
    return entry.isDirectory();
  } catch {
    return false;
  }
}

class SessionSearch {
  readonly files: string[] = [];
  private pending: string[];
  private visited = 0;

  constructor(root: string) {
    this.pending = [root];
  }

  /** False when the tree has a symlink or exceeds the entry bound. */
  async run(): Promise<boolean> {
    for (let next = this.pending.pop(); next; next = this.pending.pop())
      if (!(await this.visit(next))) return false;
    return true;
  }

  private async visit(directory: string): Promise<boolean> {
    const entries = await readdir(directory, { withFileTypes: true });
    this.visited += entries.length;
    return (
      this.visited <= MAX_SESSION_ENTRIES &&
      entries.every((entry) => this.collect(directory, entry))
    );
  }

  private collect(directory: string, entry: Dirent): boolean {
    if (entry.isSymbolicLink()) return false;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) this.pending.push(path);
    else if (entry.isFile() && entry.name.endsWith(".jsonl"))
      this.files.push(path);
    return true;
  }
}

async function sessionFiles(root: string): Promise<string[] | null> {
  const search = new SessionSearch(root);
  try {
    return (await search.run()) ? search.files : null;
  } catch {
    return null;
  }
}

interface TreeState {
  root: SessionUsage | null;
  sessions: SessionUsage[];
  reasons: Set<IncompleteReason>;
}

async function readSessions(
  files: string[],
  rootThreadId: string,
): Promise<TreeState> {
  const state: TreeState = { root: null, sessions: [], reasons: new Set() };
  const rootFiles = files.filter((path) =>
    path.endsWith(`-${rootThreadId}.jsonl`),
  );
  const rootPath = rootFiles.length === 1 ? rootFiles[0] : undefined;
  if (rootPath === undefined) state.reasons.add("root_session_unavailable");
  for (const path of files) await readInto(state, path, path === rootPath);
  return state;
}

async function readInto(
  state: TreeState,
  path: string,
  isRoot: boolean,
): Promise<void> {
  try {
    const session = await readSessionUsage(path);
    state.sessions.push(session);
    if (isRoot) state.root = session;
  } catch {
    state.reasons.add("session_unreadable");
  }
}

function spawnedBy(session: SessionUsage, linked: Set<string>): boolean {
  return (
    session.threadId !== null &&
    !linked.has(session.threadId) &&
    session.parentThreadId !== null &&
    linked.has(session.parentThreadId)
  );
}

/** Root plus every session whose spawn ancestry reaches it. */
function treeSessions(state: TreeState, rootThreadId: string): SessionUsage[] {
  if (!state.root) return [];
  const tree = [state.root];
  const linked = new Set([rootThreadId]);
  let remaining = state.sessions.filter((session) => session !== state.root);
  for (;;) {
    const spawned = remaining.filter((session) => spawnedBy(session, linked));
    if (!spawned.length) return tree;
    for (const session of spawned) linked.add(session.threadId as string);
    tree.push(...spawned);
    remaining = remaining.filter((session) => !spawned.includes(session));
  }
}

function sumTree(
  tree: SessionUsage[],
  reasons: Set<IncompleteReason>,
): TokenTotal | null {
  let total: TokenTotal | null = null;
  for (const { usage } of tree) {
    if (usage === null) reasons.add("session_usage_missing");
    else total = total ? addTotals(total, usage) : usage;
  }
  return total;
}

function tokens(total: TokenTotal | null | undefined) {
  return total
    ? { inputTokens: total.inputTokens, outputTokens: total.outputTokens }
    : { inputTokens: null, outputTokens: null };
}

function treeUsage(
  total: TokenTotal | null,
  tree: SessionUsage[],
  unlinkedSessions: number,
  reasons: Set<IncompleteReason>,
): CodexTreeUsage {
  const complete = reasons.size === 0 && total !== null;
  const root = tokens(tree[0]?.usage);
  return {
    ...tokens(total),
    complete,
    observation: {
      id: "sevro.codex.usage",
      completeness: complete ? "complete" : "partial",
      data: {
        scope: "thread_tree",
        threads: tree.length,
        rootInputTokens: root.inputTokens,
        rootOutputTokens: root.outputTokens,
        unlinkedSessions,
        incompleteReasons: [...reasons].sort(),
      },
    },
  };
}

function unmeasured(reason: IncompleteReason): CodexTreeUsage {
  return treeUsage(null, [], 0, new Set([reason]));
}

/**
 * Measure token usage for one Codex root thread and all of its subagents from
 * the native rollouts in a private Codex home. Each session contributes its
 * last cumulative `token_count` total; subagents are linked through
 * `thread_spawn.parent_thread_id`, at any depth. Other sessions are counted as
 * unlinked and excluded. An unreadable session, missing or ambiguous root,
 * incomplete search, or tree session without usage leaves the result
 * incomplete; nothing is estimated. Filesystem failures never throw.
 */
export async function codexTreeUsage(
  codexHome: string,
  rootThreadId: string,
): Promise<CodexTreeUsage> {
  const root = join(codexHome, "sessions");
  if (!THREAD_ID.test(rootThreadId) || !(await sessionsRootAvailable(root)))
    return unmeasured("sessions_unavailable");
  const files = await sessionFiles(root);
  if (files === null) return unmeasured("sessions_incomplete");
  const state = await readSessions(files, rootThreadId);
  const tree = treeSessions(state, rootThreadId);
  const total = sumTree(tree, state.reasons);
  return treeUsage(
    total,
    tree,
    state.sessions.length - tree.length,
    state.reasons,
  );
}
