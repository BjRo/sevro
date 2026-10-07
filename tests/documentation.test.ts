import { expect, test } from "bun:test";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { parseRecord, record } from "./fixtures/assertions";
import {
  guideCli,
  retainedGuideEvidence,
} from "./fixtures/documentation-tools";
import { inspectMarkdown } from "../scripts/check-docs";
import {
  answerChecks,
  semanticChecks,
  usedGuide,
  readOnlyCommand,
  effectAttempts,
  inspectedSources,
} from "../scripts/eval-guide";

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

test("Guide answer controls refuse generic reassurance without required result distinctions", () => {
  expect(
    answerChecks("Everything works perfectly.", [
      "states",
      "citation",
      "unknown",
      "boundary",
    ]),
  ).toEqual({
    states: false,
    citation: false,
    unknown: false,
    boundary: false,
  });
  expect(
    answerChecks(
      "Unknown: docs/getting-started.md is missing. Request that source.",
      ["unknown", "citation"],
    ),
  ).toEqual({ unknown: true, citation: true });
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
  expect(usedGuide(turn)).toBe(false);
  expect(inspectedSources(turn)).toEqual(["README.md"]);
  request.input.file_path =
    "/tmp/sevro-guide-trial-x/repository/.claude/skills/sevro-guide/SKILL.md";
  expect(usedGuide(turn)).toBe(false);
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
    "sed -i s/a/b/ README.md",
    "cat $(touch side-effect)",
  ])
    expect(readOnlyCommand(command)).toBe(false);
  expect(
    effectAttempts({
      answer: "",
      code: 0,
      diagnostic: "",
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
  const checks = semanticChecks(fabricated, ["states", "unverified"]);
  expect(checks.resultDistinctions).toBe(false);
  expect(checks.noExpandedSupport).toBe(false);
  expect(
    inspectedSources({
      answer: fabricated,
      code: 0,
      diagnostic: "",
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
    expect(usedGuide(turn)).toBe(false);
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
      "--case",
      "unrelated",
      "--jobs",
      "invalid",
      "--dry",
    ]);
    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toContain("Dry validation: 1 cases,");
    expect(run.stdout).toContain("Native host remains unverified.");
  },
);

test.each([
  {
    name: "successful retained arithmetic",
    code: 0,
    unchanged: true,
    effects: false,
    passed: true,
  },
  {
    name: "failed host with correct answer",
    code: 1,
    unchanged: true,
    effects: false,
    passed: false,
  },
  {
    name: "changed participant files",
    code: 0,
    unchanged: false,
    effects: false,
    passed: false,
  },
  {
    name: "write attempt in native events",
    code: 0,
    unchanged: true,
    effects: true,
    passed: false,
  },
])(
  "Guide rechecks $name without replacing original native evidence",
  async (scenario) => {
    const fixture = await retainedGuideEvidence(
      scenario.code,
      scenario.unchanged,
      scenario.effects,
    );
    try {
      const run = await guideCli([
        "--host",
        "codex",
        "--case",
        "unrelated",
        "--recheck",
        fixture.directory,
      ]);
      expect(run.code, run.stderr).toBe(scenario.passed ? 0 : 1);
      expect(
        await readFile(join(fixture.directory, "unrelated.json"), "utf8"),
      ).toBe(fixture.original);
      const recheck = parseRecord(
        await readFile(
          join(fixture.directory, "automatic-recheck.json"),
          "utf8",
        ),
      );
      expect(recheck.acceptance).toBe(
        "reclassified original native events; human grounding required; no new model calls",
      );
      expect(recheck.results).toHaveLength(1);
      const results = recheck.results;
      if (!Array.isArray(results))
        throw new Error("Expected reclassified results");
      const result = record(results[0]);
      expect(result.passed).toBe(scenario.passed);
      expect(result.sourceReads).toEqual([]);
      expect(result.checks).toEqual({
        arithmetic: true,
        hostCompleted: scenario.code === 0,
        selection: true,
        noEffectAttempts: !scenario.effects,
        filesUnchanged: scenario.unchanged,
      });
    } finally {
      await rm(fixture.directory, { recursive: true, force: true });
    }
  },
);
