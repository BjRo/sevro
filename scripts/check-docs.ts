import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { dirname, extname, isAbsolute, relative, resolve } from "node:path";
import MarkdownIt from "markdown-it";
import GithubSlugger from "github-slugger";

const parser = new MarkdownIt({ html: true });
type Page = {
  path: string;
  anchors: Set<string>;
  links: string[];
  errors: string[];
};

function attributes(html: string, name: string): string[] {
  return [
    ...html.matchAll(new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, "gi")),
  ].map((match) => match[1]);
}

function inspectHtml(page: Page, html: string): void {
  for (const id of attributes(html, "id")) page.anchors.add(id);
  page.links.push(...attributes(html, "href"), ...attributes(html, "src"));
  for (const image of html.match(/<img\b[^>]*>/gi) ?? []) {
    if (!attributes(image, "alt").some((alt) => alt.trim()))
      page.errors.push("HTML image needs nonempty alt text");
  }
}

export function inspectMarkdown(path: string, text: string): Page {
  const tokens = parser.parse(text, {});
  const page: Page = { path, anchors: new Set(), links: [], errors: [] };
  const slugger = new GithubSlugger();
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.type === "heading_open") {
      const inline = tokens[index + 1];
      const title =
        inline.children
          ?.filter((child) => ["text", "code_inline"].includes(child.type))
          .map((child) => child.content)
          .join("") ?? inline.content;
      page.anchors.add(slugger.slug(title));
    }
    if (token.type === "fence" && !token.info.trim())
      page.errors.push("code fence needs a language");
    if (token.type.startsWith("html")) inspectHtml(page, token.content);
    for (const child of token.children ?? []) {
      if (child.type.startsWith("html")) inspectHtml(page, child.content);
      if (child.type === "link_open")
        page.links.push(child.attrGet("href") ?? "");
      if (child.type === "image") {
        page.links.push(child.attrGet("src") ?? "");
        if (!child.content.trim())
          page.errors.push("image needs nonempty alt text");
      }
    }
  }
  return page;
}

async function markdownFiles(
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
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await markdownFiles(root, path)));
    else if (entry.isFile() && extname(path) === ".md") files.push(path);
  }
  return files;
}

function contained(root: string, path: string): boolean {
  const value = relative(root, path);
  return value !== ".." && !value.startsWith("../") && !isAbsolute(value);
}

async function localLink(
  root: string,
  page: Page,
  link: string,
  pages: Map<string, Page>,
): Promise<string | null> {
  if (/^(https?:|mailto:|data:)/i.test(link)) return null;
  try {
    const [target, anchor] = link.split("#", 2);
    const path =
      resolve(dirname(page.path), decodeURIComponent(target || "")) ||
      page.path;
    const destination = target ? path : page.path;
    const canonical = await realpath(destination);
    if (!contained(root, canonical)) return `link escapes repository: ${link}`;
    await stat(canonical);
    if (
      anchor &&
      extname(canonical) === ".md" &&
      !pages.get(canonical)?.anchors.has(decodeURIComponent(anchor))
    )
      return `missing anchor: ${link}`;
    return null;
  } catch {
    return `unreadable link or asset: ${link}`;
  }
}

async function guideChecks(root: string): Promise<string[]> {
  const errors: string[] = [];
  const canonical = resolve(root, ".agents/skills/sevro-guide");
  const mirror = resolve(root, ".claude/skills/sevro-guide/SKILL.md");
  const source = resolve(canonical, "SKILL.md");
  try {
    if (!(await readFile(source)).equals(await readFile(mirror)))
      errors.push(`${mirror}: guide differs from ${source}`);
    const raw: unknown = JSON.parse(
      await readFile(resolve(canonical, "evals/inventory.json"), "utf8"),
    );
    const cases: unknown = JSON.parse(
      await readFile(resolve(canonical, "evals/cases.json"), "utf8"),
    );
    if (
      !raw ||
      typeof raw !== "object" ||
      !("questions" in raw) ||
      !Array.isArray(raw.questions) ||
      !Array.isArray(cases)
    )
      throw new Error("invalid guide inventory");
    const ids = new Set(cases.map((item: { id: string }) => item.id));
    const covered = new Set<string>();
    for (const item of raw.questions as Array<{
      id: string;
      sources: string[];
      destination: string;
      cases: string[];
    }>) {
      if (!item.id || !item.sources.length || !item.cases.length)
        throw new Error("empty inventory item");
      for (const target of [...item.sources, item.destination]) {
        const path = resolve(root, target);
        if (!contained(root, await realpath(path)))
          throw new Error(`inventory target escapes repository: ${target}`);
        await stat(path);
      }
      for (const id of item.cases) {
        if (!ids.has(id)) throw new Error(`inventory names absent case: ${id}`);
        covered.add(id);
      }
    }
    if (covered.size !== ids.size)
      throw new Error("inventory does not cover every case");
  } catch (error) {
    errors.push(
      `${canonical}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return errors;
}

async function externalLink(page: string, url: string): Promise<string | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(15000),
        redirect: "follow",
      });
      await response.body?.cancel();
      if (response.ok) return null;
      if (![408, 429].includes(response.status) && response.status < 500)
        return `${page}: HTTP ${response.status} ${url} (triage authentication/bot blocks separately)`;
      if (attempt === 2)
        return `${page}: HTTP ${response.status} ${url} after 3 attempts`;
    } catch (error) {
      if (attempt === 2)
        return `${page}: ${url}: ${error instanceof Error ? error.message : String(error)} after 3 attempts`;
    }
  }
  return null;
}

export async function checkDocs(
  root: string,
  external = false,
): Promise<string[]> {
  root = await realpath(root);
  const pages = new Map<string, Page>();
  for (const path of await markdownFiles(root))
    pages.set(path, inspectMarkdown(path, await readFile(path, "utf8")));
  const errors: string[] = [];
  const remote = new Map<string, string>();
  for (const page of pages.values()) {
    errors.push(...page.errors.map((error) => `${page.path}: ${error}`));
    for (const link of page.links) {
      const error = await localLink(root, page, link, pages);
      if (error) errors.push(`${page.path}: ${error}`);
      if (/^https?:/i.test(link)) remote.set(link, page.path);
    }
  }
  errors.push(...(await guideChecks(root)));
  if (external) {
    const entries = [...remote.entries()];
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
  }
  return errors;
}

if (import.meta.main) {
  const errors = await checkDocs(
    resolve(import.meta.dir, ".."),
    Bun.argv.includes("--external"),
  );
  for (const error of errors) console.error(error);
  if (errors.length) process.exitCode = 1;
  else
    console.log(
      `Documentation checks passed: ${resolve(import.meta.dir, "..")}`,
    );
}
