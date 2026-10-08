import { readdir, realpath, stat } from "node:fs/promises";
import { dirname, extname, isAbsolute, relative, resolve } from "node:path";
import type { Page } from "./documentation-markdown";
import type { Dirent } from "node:fs";

export function contained(root: string, path: string): boolean {
  const value = relative(root, path);
  return value !== ".." && !value.startsWith("../") && !isAbsolute(value);
}

export async function markdownFiles(
  root: string,
  directory = root,
): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (
      [
        ".git",
        ".worktrees",
        "node_modules",
        ".guide-results",
        "tests",
      ].includes(entry.name)
    )
      continue;
    files.push(...(await markdownEntry(root, directory, entry)));
  }
  return files;
}

async function markdownEntry(
  root: string,
  directory: string,
  entry: Dirent,
): Promise<string[]> {
  const path = resolve(directory, entry.name);
  if (entry.isDirectory()) return markdownFiles(root, path);
  return entry.isFile() && extname(path) === ".md" ? [path] : [];
}

function missingAnchor(
  canonical: string,
  anchor: string | undefined,
  pages: Map<string, Page>,
): boolean {
  if (!anchor || extname(canonical) !== ".md") return false;
  return !pages.get(canonical)?.anchors.has(decodeURIComponent(anchor));
}

export async function localLink(
  root: string,
  page: Page,
  link: string,
  pages: Map<string, Page>,
): Promise<string | null> {
  if (/^(https?:|mailto:|data:)/i.test(link)) return null;
  try {
    const [target, anchor] = link.split("#", 2);
    const canonical = await realpath(linkDestination(page, target));
    if (!contained(root, canonical)) return `link escapes repository: ${link}`;
    await stat(canonical);
    if (missingAnchor(canonical, anchor, pages))
      return `missing anchor: ${link}`;
    return null;
  } catch {
    return `unreadable link or asset: ${link}`;
  }
}

function linkDestination(page: Page, target: string | undefined): string {
  const path = resolve(dirname(page.path), decodeURIComponent(target ?? ""));
  return target ? path : page.path;
}

function retryStatus(status: number): boolean {
  return [408, 429].includes(status) || status >= 500;
}

async function externalAttempt(
  page: string,
  url: string,
  attempt: number,
): Promise<string | null | undefined> {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(15000),
      redirect: "follow",
    });
    await response.body?.cancel();
    if (response.ok) return null;
    return externalResponse(page, url, attempt, response.status);
  } catch (error) {
    return externalFailure(page, url, attempt, error);
  }
}

function externalResponse(
  page: string,
  url: string,
  attempt: number,
  status: number,
): string | undefined {
  if (!retryStatus(status))
    return `${page}: HTTP ${status} ${url} (triage authentication/bot blocks separately)`;
  if (attempt === 2) return `${page}: HTTP ${status} ${url} after 3 attempts`;
  return undefined;
}

function externalFailure(
  page: string,
  url: string,
  attempt: number,
  error: unknown,
): string | undefined {
  if (attempt !== 2) return undefined;
  return `${page}: ${url}: ${error instanceof Error ? error.message : String(error)} after 3 attempts`;
}

async function externalLink(page: string, url: string): Promise<string | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const result = await externalAttempt(page, url, attempt);
    if (result !== undefined) return result;
  }
  return null;
}

export async function externalLinks(
  remote: Map<string, string>,
): Promise<string[]> {
  const entries = [...remote.entries()];
  const errors: string[] = [];
  for (let offset = 0; offset < entries.length; offset += 8) {
    const results = await Promise.all(
      entries
        .slice(offset, offset + 8)
        .map(([url, page]) => externalLink(page, url)),
    );
    errors.push(
      ...results.filter((result): result is string => result !== null),
    );
  }
  return errors;
}
