import MarkdownIt from "markdown-it";
import type Token from "markdown-it/lib/token.mjs";
import GithubSlugger from "github-slugger";

export type Page = {
  path: string;
  anchors: Set<string>;
  links: string[];
  errors: string[];
};
const parser = new MarkdownIt({ html: true });

function attributes(html: string, name: string): string[] {
  return [
    ...html.matchAll(new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, "gi")),
  ].map((match) => match[1] ?? "");
}

function inspectHtml(page: Page, html: string): void {
  for (const id of attributes(html, "id")) page.anchors.add(id);
  page.links.push(...attributes(html, "href"), ...attributes(html, "src"));
  for (const image of html.match(/<img\b[^>]*>/gi) ?? []) {
    if (!attributes(image, "alt").some((alt) => alt.trim()))
      page.errors.push("HTML image needs nonempty alt text");
  }
}

function headingTitle(inline: Token | undefined): string {
  const children = inline?.children;
  if (children)
    return children
      .filter((child) => ["text", "code_inline"].includes(child.type))
      .map((child) => child.content)
      .join("");
  return inline?.content ?? "";
}

function inspectBlock(
  page: Page,
  token: Token,
  inline: Token | undefined,
  slugger: GithubSlugger,
): void {
  if (token.type === "heading_open")
    page.anchors.add(slugger.slug(headingTitle(inline)));
  if (token.type === "fence" && !token.info.trim())
    page.errors.push("code fence needs a language");
  if (token.type.startsWith("html")) inspectHtml(page, token.content);
}

function inspectChild(page: Page, child: Token): void {
  switch (child.type) {
    case "link_open":
      page.links.push(child.attrGet("href") ?? "");
      break;
    case "image":
      inspectImage(page, child);
      break;
    default:
      if (child.type.startsWith("html")) inspectHtml(page, child.content);
  }
}

function inspectImage(page: Page, child: Token): void {
  page.links.push(child.attrGet("src") ?? "");
  if (!child.content.trim()) page.errors.push("image needs nonempty alt text");
}

export function inspectMarkdown(path: string, text: string): Page {
  const tokens = parser.parse(text, {});
  const page: Page = { path, anchors: new Set(), links: [], errors: [] };
  const slugger = new GithubSlugger();
  for (const [index, token] of tokens.entries()) {
    inspectBlock(page, token, tokens[index + 1], slugger);
    for (const child of token.children ?? []) inspectChild(page, child);
  }
  return page;
}
