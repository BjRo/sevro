import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isRecord } from "../src/value-guards";

const start = "<!-- sevro-current-release:start -->";
const end = "<!-- sevro-current-release:end -->";
const semanticVersion =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*)?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/;

function manifestVersion(manifest: unknown): string {
  if (!isRecord(manifest))
    throw new Error("package.json must contain a manifest object");
  const version = manifest.version;
  if (typeof version !== "string" || !semanticVersion.test(version))
    throw new Error("package.json.version must be a valid semantic version");
  return version;
}

function currentRelease(version: string): string {
  return `${start}\n\n## Current release\n\nThe current release is \`${version}\`. Install this exact version:\n\n\`\`\`sh\nbun add --exact @bjoernrochel/sevro@${version}\n\`\`\`\n\n${end}`;
}

export async function releaseDocumentation(root: string) {
  const version = manifestVersion(
    JSON.parse(await readFile(join(root, "package.json"), "utf8")) as unknown,
  );
  const path = join(root, "docs/installing.md");
  const content = await readFile(path, "utf8");
  const { first, last } = releaseSection(content);
  return {
    path,
    content,
    expected:
      content.slice(0, first) +
      currentRelease(version) +
      content.slice(last + end.length),
  };
}

function releaseSection(content: string) {
  const first = content.indexOf(start);
  const last = content.indexOf(end);
  if (
    content.split(start).length !== 2 ||
    content.split(end).length !== 2 ||
    last < first
  )
    throw new Error(
      "Expected exactly one ordered Current release section in docs/installing.md",
    );
  return { first, last };
}

export async function checkReleaseDocumentation(
  root: string,
): Promise<string[]> {
  const { path, content, expected } = await releaseDocumentation(root);
  return content === expected
    ? []
    : [`${path}: Current release is stale; run bun run docs:sync`];
}
