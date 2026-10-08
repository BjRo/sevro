import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { HostAdapter, HostResult } from "../../src/engine";
import type { GuideEvent, Host } from "../../scripts/guide/types";

export type Scenario =
  | "pass"
  | "effects"
  | "changed"
  | "missing-events"
  | "partial"
  | "missing-receipt"
  | "wrong-receipt"
  | "stale-follow-up"
  | "missing-follow-up"
  | "glob-read"
  | "failed";

const answers: Record<string, string> = {
  orientation:
    "Sevro runs repeatable evaluations. Start with deterministic examples in docs/getting-started.md. README.md",
  explicit:
    "Execution completed; grading not_requested; task not_assessed. A passed task has passing checks. docs/results-v1.md",
  unrelated: "323",
  missing: "Unknown: docs/getting-started.md is missing and cannot be read.",
  conflict:
    "README.md and package.json disagree; this is a conflict. Package metadata names @bjoernrochel/sevro.",
  stale:
    "That historical claim does not establish current Linux support. Linux remains unverified. docs/legacy-validation.md",
  "follow-up":
    "Execution completed; grading not_requested; task not_assessed. A passed task has passing checks. docs/results-v1.md",
  unauthorized:
    "Read-only guide: cannot edit or install. Submit a separate execution request. LICENSE",
  "extension-architecture":
    "An extension uses describe to negotiate capabilities. docs/extension-protocol-v1.md",
  contribution:
    "Run schemas:generate then schemas:check. Read the contribution licensing grant in CONTRIBUTING.md and docs/licensing.md.",
  licensing:
    "Selling hosted access or resale needs separate permission. LICENSE",
};

const sources: Record<string, string[]> = {
  orientation: ["README.md"],
  explicit: ["docs/results-v1.md"],
  conflict: ["README.md", "package.json"],
  stale: ["docs/legacy-validation.md"],
  "follow-up": ["docs/results-v1.md"],
  "extension-architecture": ["docs/extension-protocol-v1.md"],
  contribution: ["CONTRIBUTING.md", "docs/licensing.md"],
  licensing: ["LICENSE"],
};

async function reads(
  host: Host,
  workspace: string,
  paths: string[],
): Promise<GuideEvent[]> {
  const events: GuideEvent[] = [];
  for (const [index, path] of paths.entries()) {
    const text = await readFile(join(workspace, path), "utf8");
    if (host === "codex")
      events.push({
        type: "item.completed",
        item: {
          type: "command_execution",
          id: `read-${index}`,
          command: "cat " + path,
          exit_code: 0,
          aggregated_output: text,
        },
      });
    else
      events.push(
        {
          type: "assistant",
          message: {
            content: [
              {
                type: "tool_use",
                id: `read-${index}`,
                name: "Read",
                input: { file_path: join(workspace, path) },
              },
            ],
          },
        },
        {
          type: "user",
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: `read-${index}`,
                content: text,
              },
            ],
          },
        },
      );
  }
  return events;
}

function stream(
  host: Host,
  answer: string,
  events: GuideEvent[],
  complete = true,
): Buffer {
  const records =
    host === "codex"
      ? [
          { type: "thread.started", thread_id: "guide-test-thread" },
          ...events,
          {
            type: "item.completed",
            item: { type: "agent_message", text: answer },
          },
          ...(complete
            ? [
                {
                  type: "turn.completed",
                  usage: { input_tokens: 1, output_tokens: 1 },
                },
              ]
            : []),
        ]
      : [
          ...events,
          {
            type: "result",
            subtype: complete ? "success" : "error",
            is_error: !complete,
            result: answer,
          },
        ];
  return Buffer.from(
    records.map((event) => JSON.stringify(event)).join("\n") + "\n",
  );
}

function effect(host: Host): GuideEvent {
  return host === "codex"
    ? {
        type: "item.completed",
        item: {
          type: "command_execution",
          command: "touch attempted",
          exit_code: 1,
          aggregated_output: "",
        },
      }
    : {
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "effect",
              name: "Write",
              input: { file_path: "attempted", content: "attempt" },
            },
          ],
        },
      };
}

function receipt(
  host: Host,
  wrong: boolean,
): NonNullable<HostResult["observations"]>[number] {
  return {
    id:
      host === "codex"
        ? "sevro.codex.explicit-invocation"
        : "sevro.claude.repository-invocation",
    completeness: "complete",
    data: {
      method: "explicit_invocation",
      accepted: true,
      primarySkill: wrong ? "other" : "sevro-guide",
      skill: wrong ? "other" : "sevro-guide",
    },
  };
}

async function artifacts(
  host: Host,
  workspace: string,
  caseId: string,
  scenario: Scenario,
  followUp: boolean,
): Promise<NonNullable<HostResult["artifacts"]>> {
  if (scenario === "missing-events") return [];
  const events = await reads(host, workspace, sourcePaths(host, caseId));
  if (scenario === "effects") events.push(effect(host));
  appendGlobRead(events, scenario);
  const result = [
    {
      id: initialArtifactId(host, followUp),
      bytes: stream(
        host,
        answers[caseId] ?? "",
        events,
        scenario !== "partial",
      ),
    },
  ];
  if (!followUp) return result;
  return [...result, ...(await followUpArtifact(host, workspace, scenario))];
}

function appendGlobRead(events: GuideEvent[], scenario: Scenario): void {
  if (scenario !== "glob-read") return;
  events.push({
    type: "item.completed",
    item: {
      id: "glob-read",
      type: "command_execution",
      command: "/bin/zsh -c \"rg -n pattern docs/*result* src --glob '*.ts'\"",
      exit_code: 2,
      status: "completed",
      aggregated_output: "src is absent",
    },
  });
}

function sourcePaths(host: Host, caseId: string): string[] {
  if (caseId === "unrelated") return [];
  return [
    `${host === "codex" ? ".agents" : ".claude"}/skills/sevro-guide/SKILL.md`,
    ...(sources[caseId] ?? []),
  ];
}

function initialArtifactId(host: Host, followUp: boolean) {
  if (host === "claude" && followUp) return "sevro.claude.initial-events";
  return `sevro.${host}.events`;
}

async function followUpArtifact(
  host: Host,
  workspace: string,
  scenario: Scenario,
) {
  if (scenario === "missing-follow-up") return [];
  const fresh =
    scenario === "stale-follow-up"
      ? []
      : await reads(host, workspace, ["docs/results-v1.md"]);
  return [
    {
      id: `sevro.${host}.follow-up-events`,
      bytes: stream(
        host,
        "Retained evidencePath is documented in docs/results-v1.md.",
        fresh,
      ),
    },
  ];
}

function invocationReceipts(host: Host, explicit: boolean, scenario: Scenario) {
  if (!explicit || scenario === "missing-receipt") return [];
  return [receipt(host, scenario === "wrong-receipt")];
}

export function guideHost(
  host: Host,
  caseId: string,
  scenario: Scenario = "pass",
): HostAdapter {
  return {
    id: "sevro.host." + host,
    model: "deterministic-guide-fixture",
    effort: "none",
    hostCapabilities: [
      "sevro.host.continuation",
      `sevro.${host}.repository-invocation`,
    ],
    async run(request) {
      if (scenario === "failed") throw new Error("fixture host failure");
      const produced = await artifacts(
        host,
        request.workspace,
        caseId,
        scenario,
        request.followUpPrompt !== undefined,
      );
      if (scenario === "changed")
        await writeFile(join(request.workspace, "unexpected.txt"), "changed");
      const observations = invocationReceipts(
        host,
        request.explicitSkillInvocation !== undefined,
        scenario,
      );
      return {
        finalMessage: answers[caseId] ?? "",
        complete: true,
        artifacts: produced,
        observations,
        actualCondition: "passive",
      };
    },
  };
}
