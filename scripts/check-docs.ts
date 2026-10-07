import { readFile, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { inspectMarkdown, type Page } from "./documentation-markdown";
import { externalLinks, localLink, markdownFiles } from "./documentation-links";
import { guideChecks } from "./documentation-inventory";
export { inspectMarkdown } from "./documentation-markdown";

async function pageChecks(
  root: string,
  page: Page,
  pages: Map<string, Page>,
  remote: Map<string, string>,
): Promise<string[]> {
  const errors = page.errors.map((error) => `${page.path}: ${error}`);
  for (const link of page.links) {
    const error = await localLink(root, page, link, pages);
    if (error) errors.push(`${page.path}: ${error}`);
    if (/^https?:/i.test(link)) remote.set(link, page.path);
  }
  return errors;
}

export async function checkDocs(
  root: string,
  external = false,
): Promise<string[]> {
  root = await realpath(root);
  const pages = new Map<string, Page>();
  for (const path of await markdownFiles(root))
    pages.set(path, inspectMarkdown(path, await readFile(path, "utf8")));
  const errors: string[] = [],
    remote = new Map<string, string>();
  for (const page of pages.values())
    errors.push(...(await pageChecks(root, page, pages, remote)));
  errors.push(...(await guideChecks(root)));
  if (external) errors.push(...(await externalLinks(remote)));
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
