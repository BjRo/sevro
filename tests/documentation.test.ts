import { expect, test } from "bun:test";
import { guideCli } from "./fixtures/documentation-tools";
import { inspectMarkdown } from "../scripts/check-docs";
import {
  usedGuide,
  readOnlyCommand,
  effectAttempts,
  inspectedSources,
} from "../scripts/guide/evidence";
import {
  gradeOutput,
  prepareOutputChecks,
  isOutputGrader,
} from "../src/graders/output";
import cases from "../.agents/skills/sevro-guide/evals/cases.json";

function prepared(
  checks: {
    id: string;
    grader: string;
    configuration: Record<string, unknown>;
  }[],
) {
  return prepareOutputChecks(
    checks.map((check) => {
      const grader = check.grader;
      if (!isOutputGrader(grader))
        throw new Error("Expected a built-in output grader");
      return { ...check, grader };
    }),
  );
}

test("Markdown parser ignores code links and applies duplicate GitHub heading anchors", () => {
  const page = inspectMarkdown(
    "/tmp/page.md",
    '# Results\n# Results\n\n```sh\necho "[fake](missing.md)"\n```\n\n[real](target.md#results-1)\n<a id="stable"></a>\n',
  );
  expect([...page.anchors]).toEqual(["results", "results-1", "stable"]);
  expect(page.links).toEqual(["target.md#results-1"]);
  expect(page.errors).toEqual([]);
});

test("Markdown and HTML images need alternatives and fenced commands need languages", () => {
  const page = inspectMarkdown(
    "/tmp/page.md",
    '![](logo.png)\n<img src="other.png" alt="">\n```\ncommand\n```\n',
  );
  expect(page.links).toEqual(["logo.png", "other.png"]);
  expect(page.errors).toHaveLength(3);
});

test("Declarative guide answer rules reject generic reassurance", () => {
  for (const id of ["explicit", "missing", "unauthorized"]) {
    const selected = cases.find((item) => item.id === id);
    if (!selected) throw new Error("Missing case");
    const checks = prepared(selected.checks);
    expect(
      gradeOutput("Everything works perfectly.", true, checks).some(
        (check) => check.status === "failed",
      ),
    ).toBe(true);
  }
});

test("Native discovery is not satisfied by the skill name in an unrelated fixture path", () => {
  const request = {
    type: "tool_use",
    id: "read1",
    name: "Read",
    input: { file_path: "/tmp/sevro-guide-trial-x/repository/README.md" },
  };
  const turn = {
    answer: "",
    code: 0,
    diagnostic: "",
    events: [
      {
        type: "assistant",
        message: {
          content: [request],
        },
      },
      {
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "read1",
              content: "Repository introduction",
            },
          ],
        },
      },
    ],
  };
  expect(usedGuide(turn, "Canonical guide body")).toBe(false);
  expect(inspectedSources(turn)).toEqual(["README.md"]);
  request.input.file_path =
    "/tmp/sevro-guide-trial-x/repository/.claude/skills/sevro-guide/SKILL.md";
  expect(usedGuide(turn, "Canonical guide body")).toBe(false);
});

test("Read-only command classification ignores words in grep patterns and rejects execution", () => {
  expect(
    readOnlyCommand("nl -ba docs/results-v1.md | sed -n '3,7p;101,111p'"),
  ).toBe(true);
  expect(readOnlyCommand("sed -n '1p;e touch side-effect' README.md")).toBe(
    false,
  );
  expect(
    readOnlyCommand(
      "/bin/zsh -lc \"rg -n 'name|npm|install' package.json README.md\"",
    ),
  ).toBe(true);
  for (const command of [
    "python3 -m pytest",
    "node script.js",
    "git tag v1",
    "gh issue create",
    "curl https://example.com",
    "mystery-command",
    "cat README.md > copied.md",
    "rg --pre executable pattern",
    "rg needle *",
    "sed -i s/a/b/ README.md",
    "cat $(touch side-effect)",
  ])
    expect(readOnlyCommand(command)).toBe(false);
  expect(
    effectAttempts({
      answer: "",
      events: [
        {
          type: "item.completed",
          item: {
            type: "command_execution",
            command: "gh issue create",
            exit_code: 0,
          },
        },
      ],
    }),
  ).toEqual(["gh issue create"]);
});

test("Lexical signals cannot validate contradictory benchmark claims", () => {
  const fabricated =
    "README.md: deterministic evaluation. Prompt-only grading is passed. Unknown conflict between README.md and package.json; install the invented package. Linux support is not unverified. evidencePath. Read-only.";

  for (const id of ["explicit", "stale"]) {
    const selected = cases.find((item) => item.id === id);
    if (!selected) throw new Error("Missing case");
    expect(
      gradeOutput(fabricated, true, prepared(selected.checks)).some(
        (check) => check.status === "failed",
      ),
    ).toBe(true);
  }
  expect(
    inspectedSources({
      answer: fabricated,
      events: [],
    }),
  ).toEqual([]);
});

test("Mentioning or listing a source is not content inspection or guide activation", () => {
  for (const command of [
    "echo .agents/skills/sevro-guide/SKILL.md",
    "printf .agents/skills/sevro-guide/SKILL.md",
    "rg --files docs README.md",
    "rg -Hnc Sevro README.md",
    "grep -Hnc Sevro README.md",
    "rg --count=1 Sevro README.md",
    "ls README.md",
  ]) {
    const turn = {
      answer: "README.md",
      code: 0,
      diagnostic: "",
      events: [
        {
          type: "item.completed",
          item: {
            type: "command_execution",
            command,
            exit_code: 0,
            aggregated_output:
              "README.md\n.agents/skills/sevro-guide/SKILL.md\n",
          },
        },
      ],
    };
    expect(usedGuide(turn, "Canonical guide body")).toBe(false);
    expect(inspectedSources(turn)).toEqual([]);
  }
  const listing = {
    answer: "README.md",
    code: 0,
    diagnostic: "",
    events: [
      {
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "grep1",
              name: "Grep",
              input: { pattern: "Sevro", output_mode: "files_with_matches" },
            },
          ],
        },
      },
      {
        type: "user",
        message: {
          content: [
            { type: "tool_result", tool_use_id: "grep1", content: "README.md" },
          ],
        },
      },
    ],
  };
  expect(inspectedSources(listing)).toEqual([]);
});

test.each(["codex", "claude"])(
  "Guide dry validation selects a case without invoking %s",
  async (host) => {
    const run = await guideCli([
      "--host",
      host,
      "--case-id",
      "unrelated",

      ...(host === "codex"
        ? [
            "--codex-bin",
            "/bin/false",
            "--codex-auth-file",
            "/unused-auth.json",
          ]
        : ["--claude-bin", "/bin/false", "--claude-project-settings"]),
      "--model",
      "dry-unverified",
      "--effort",
      "medium",
      "--json",

      "--dry",
    ]);
    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toContain('"execution":{"status":"not_run"}');
    expect(run.stdout).toContain('"task":{"verdict":"not_assessed"}');
    expect(run.stdout).toContain("/run.json");
  },
);
