import type { Dirent } from "node:fs";
import { lstat, readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { isMissingFile } from "../fixture-tools";

const MAX_SESSION_BYTES = 8 * 1024 * 1024;
const MAX_SESSION_FILES = 1024;
const THREAD_ID = /^[A-Za-z0-9._-]{1,128}$/;
type SearchStatus = "partial" | "unavailable" | "ambiguous";
type SessionLocation =
  { status: SearchStatus } | { status: "found"; path: string };

async function sessionsRootStatus(
  root: string,
): Promise<"valid" | "partial" | "unavailable"> {
  try {
    const entry = await lstat(root);
    return entry.isDirectory() && !entry.isSymbolicLink() ? "valid" : "partial";
  } catch (error) {
    return isMissingFile(error) ? "unavailable" : "partial";
  }
}

class SessionSearch {
  private pending: string[];
  private matches: string[] = [];
  private visited = 0;
  constructor(
    root: string,
    private suffix: string,
  ) {
    this.pending = [root];
  }

  async run(): Promise<SessionLocation> {
    while (this.pending.length) {
      const directory = this.pending.pop();
      if (directory === undefined) break;
      try {
        const status = await this.visitDirectory(directory);
        if (status) return { status };
      } catch {
        return { status: "partial" };
      }
    }
    const [path] = this.matches;
    return this.location(path);
  }

  private location(path: string | undefined): SessionLocation {
    return this.matches.length === 1 && path !== undefined
      ? { status: "found", path }
      : { status: "unavailable" };
  }

  private async visitDirectory(
    directory: string,
  ): Promise<SearchStatus | undefined> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const status = this.visitEntry(directory, entry);
      if (status) return status;
    }
    return undefined;
  }

  private visitEntry(
    directory: string,
    entry: Dirent,
  ): SearchStatus | undefined {
    this.visited++;
    if (this.visited > MAX_SESSION_FILES || entry.isSymbolicLink())
      return "partial";
    return this.collectCandidate(directory, entry);
  }

  private collectCandidate(
    directory: string,
    entry: Dirent,
  ): SearchStatus | undefined {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) this.pending.push(path);
    else if (entry.isFile() && entry.name.endsWith(this.suffix))
      this.matches.push(path);
    return this.matches.length > 1 ? "ambiguous" : undefined;
  }
}

/** Locate exactly one original thread while refusing symlinks and bounded tree overflow. */
export async function locateNativeSession(
  home: string,
  threadId: string,
): Promise<SessionLocation> {
  if (!THREAD_ID.test(threadId)) return { status: "partial" };
  const root = join(home, "sessions");
  const status = await sessionsRootStatus(root);
  if (status !== "valid") return { status };
  return new SessionSearch(root, `-${threadId}.jsonl`).run();
}

export async function readNativeSession(path: string): Promise<string | null> {
  if ((await stat(path)).size > MAX_SESSION_BYTES) return null;
  const bytes = await readFile(path);
  if (bytes.byteLength > MAX_SESSION_BYTES) return null;
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

export async function readNativeSessionText(
  path: string,
): Promise<string | null> {
  if ((await stat(path)).size > MAX_SESSION_BYTES) return null;
  const text = await readFile(path, "utf8");
  return Buffer.byteLength(text) > MAX_SESSION_BYTES ? null : text;
}
