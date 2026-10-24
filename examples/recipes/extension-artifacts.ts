import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export function artifact(relativePath: string, content: string) {
  return {
    id: `recipes.${createHash("sha256").update(relativePath).digest("hex").slice(0, 16)}`,
    relativePath,
    sha256: createHash("sha256").update(content).digest("hex"),
    contentBase64: Buffer.from(content).toString("base64"),
    gitExclude: true,
  };
}

export async function repositoryArtifacts(host: string) {
  const directory = host === "claude" ? ".claude" : ".agents";
  const relative = `${directory}/skills/startup-guide/SKILL.md`;
  const body = await readFile(
    join(import.meta.dirname, "repository-skill", relative),
    "utf8",
  );
  return [artifact(relative, body)];
}

export function pluginArtifacts() {
  const files = {
    "marketplace/.claude-plugin/marketplace.json": JSON.stringify({
      name: "recipes",
      owner: { name: "Sevro examples" },
      plugins: [
        { name: "startup", source: "./plugin", description: "Startup recipe" },
      ],
    }),
    "marketplace/plugin/.claude-plugin/plugin.json": JSON.stringify({
      name: "startup",
      version: "1.0.0",
    }),
    "marketplace/plugin/.codex-plugin/plugin.json": JSON.stringify({
      name: "startup",
      version: "1.0.0",
      skills: "./skills/",
    }),
    "marketplace/plugin/skills/startup-guide/SKILL.md":
      "---\nname: startup-guide\ndescription: Explain application startup.\n---\nRead README.md. Explain its command and port.\n",
    "marketplace/plugin/hooks/hooks.json": JSON.stringify({
      hooks: {
        SessionStart: [
          {
            hooks: [
              {
                type: "command",
                command: '/bin/sh "${CLAUDE_PLUGIN_ROOT}/hooks/start.sh"',
              },
            ],
          },
        ],
      },
    }),
    "marketplace/plugin/hooks/start.sh":
      "#!/bin/sh\nprintf 'hook ran\\n' > \"$PWD/hook-ran.txt\"\n",
  };
  return Object.entries(files).map(([path, content]) =>
    artifact(path, content),
  );
}
