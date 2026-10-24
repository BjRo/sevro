import { afterEach, expect, test } from "bun:test";
import { runEvaluation } from "../../../src/engine";
import {
  completeProbeBody,
  isolatedNativeHost,
  pagedSkillPages,
  runPagedCodex,
  sharedSkillParagraph,
  siblingSkillBody,
} from "../../fixtures/codex-host";
import { createEvaluation } from "../../fixtures/evaluation-fixtures";
import { createTemporaryFixtures } from "../../fixtures/filesystem";

const roots: string[] = [];
const { cleanupTemporaryFixtures } = createTemporaryFixtures(roots);
afterEach(cleanupTemporaryFixtures);

test("complete Codex skill reads do not imply partial reads of shared siblings", async () => {
  if (!isolatedNativeHost) return;
  const result = await runPagedCodex(roots, [{ text: completeProbeBody }], {
    body: completeProbeBody,
    siblings: { sibling: siblingSkillBody },
  });
  expect(result.complete).toBe(true);
  expect(
    result.observations?.find(
      (item) => item.id === "sevro.host.skill-activations",
    ),
  ).toMatchObject({
    completeness: "complete",
    data: {
      observedSkills: ["probe"],
      partialSkills: [],
      ambiguousSkills: [],
      catalogComplete: true,
      truncated: false,
      calls: [{ invocations: ["probe"], partial: false }],
    },
  });
});

test("overlapping complete Codex skill bodies explain their shared fragments", async () => {
  if (!isolatedNativeHost) return;
  const tail = "Return the second skill's independent public result.\n";
  const result = await runPagedCodex(
    roots,
    [{ text: completeProbeBody + tail }],
    {
      body: completeProbeBody,
      siblings: {
        other: sharedSkillParagraph + tail,
        sibling:
          "Different beginning.\n" + pagedSkillPages.join("") + "Unread end.\n",
      },
    },
  );
  expect(
    result.observations?.find(
      (item) => item.id === "sevro.host.skill-activations",
    ),
  ).toMatchObject({
    completeness: "complete",
    data: {
      observedSkills: ["other", "probe"],
      partialSkills: [],
      ambiguousSkills: [],
    },
  });
});

test.each([
  {
    name: "shared paragraph before the complete body",
    pages: [sharedSkillParagraph + completeProbeBody],
  },
  {
    name: "shared paragraph after the complete body",
    pages: [completeProbeBody + sharedSkillParagraph],
  },
  {
    name: "earlier sibling read",
    pages: [sharedSkillParagraph, completeProbeBody],
  },
  {
    name: "later sibling read",
    pages: [completeProbeBody, sharedSkillParagraph],
  },
  {
    name: "distinct sibling instructions",
    pages: [completeProbeBody + siblingSkillBody.slice(0, 100)],
  },
])(
  "independent partial sibling reads remain partial: $name",
  async ({ pages }) => {
    if (!isolatedNativeHost) return;
    const result = await runPagedCodex(
      roots,
      pages.map((text) => ({ text })),
      {
        body: completeProbeBody,
        siblings: { sibling: siblingSkillBody },
      },
    );
    expect(
      result.observations?.find(
        (item) => item.id === "sevro.host.skill-activations",
      ),
    ).toMatchObject({
      completeness: "partial",
      data: {
        observedSkills: ["probe"],
        partialSkills: ["sibling"],
        ambiguousSkills: [],
        truncated: false,
      },
    });
  },
);

test("Codex host accounts for paged tool results", async () => {
  if (!isolatedNativeHost) return;
  const result = await runPagedCodex(
    roots,
    pagedSkillPages.map((text) => ({ text })),
  );
  expect(result.complete).toBe(true);
  expect(
    result.observations?.find(
      (item) => item.id === "sevro.host.skill-activations",
    ),
  ).toMatchObject({
    completeness: "complete",
    data: { method: "tool_result_body_match", observedSkills: ["probe"] },
  });
  expect(JSON.stringify(result.observations)).not.toContain(
    "private-output-prefix",
  );
  expect(JSON.stringify(result.observations)).not.toContain(pagedSkillPages[0]);
});

test("exposure claims satisfy positive evidence requirements without completing aggregate activation", async () => {
  if (!isolatedNativeHost) return;
  const hostResult = await runPagedCodex(roots, [
    { text: "gap", omitPost: true },
    { text: pagedSkillPages[0] },
  ]);
  const evaluation = createEvaluation(roots);
  const positive = await evaluation(hostResult);
  positive.case.requiredEvidence = ["sevro.host.skill-exposure-claims"];
  const accepted = await runEvaluation(positive);
  expect(accepted.result.task.verdict).toBe("passed");
  const aggregate = await evaluation(hostResult);
  aggregate.case.requiredEvidence = ["sevro.host.skill-activations"];
  const unknown = await runEvaluation(aggregate);
  expect(unknown.result.task.verdict).toBe("not_assessed");
  expect(unknown.result.exitCode).toBe(4);
});

test.each([
  { name: "missing tail", pages: [{ text: pagedSkillPages[0] }] },
  {
    name: "duplicate page",
    pages: [{ text: pagedSkillPages[0] }, { text: pagedSkillPages[0] }],
  },
  {
    name: "other session",
    pages: [
      { text: pagedSkillPages[0] },
      { text: pagedSkillPages[1], session: "child-1" },
    ],
  },
  {
    name: "other turn",
    pages: [
      { text: pagedSkillPages[0] },
      { text: pagedSkillPages[1], turn: "turn-2" },
    ],
  },
  {
    name: "hole",
    pages: [
      { text: pagedSkillPages.join("").slice(0, 80) },
      { text: pagedSkillPages.join("").slice(90) },
    ],
  },
  {
    name: "changed tail",
    pages: [
      { text: pagedSkillPages[0] },
      {
        text: pagedSkillPages[1].replace(
          "second instruction",
          "changed instruction",
        ),
      },
    ],
  },
])("incomplete paged tool results stay unknown: $name", async ({ pages }) => {
  if (!isolatedNativeHost) return;
  const result = await runPagedCodex(roots, pages);
  expect(result.complete).toBe(true);
  expect(
    result.observations?.find(
      (item) => item.id === "sevro.host.skill-activations",
    ),
  ).toMatchObject({
    completeness: "partial",
    data: { observedSkills: [], partialSkills: ["probe"] },
  });
});

test.each([
  { name: "reverse order", pages: [...pagedSkillPages].reverse() },
  {
    name: "overlap",
    pages: [
      pagedSkillPages.join("").slice(0, 140),
      pagedSkillPages.join("").slice(100),
    ],
  },
  {
    name: "full body resolves fragments",
    pages: [pagedSkillPages[0], pagedSkillPages.join(""), pagedSkillPages[1]],
  },
])("complete paged tool results tolerate $name", async ({ pages }) => {
  if (!isolatedNativeHost) return;
  const result = await runPagedCodex(
    roots,
    pages.map((text) => ({ text })),
  );
  expect(
    result.observations?.find(
      (item) => item.id === "sevro.host.skill-activations",
    ),
  ).toMatchObject({
    completeness: "complete",
    data: { observedSkills: ["probe"], partialSkills: [] },
  });
});

test("paged tool results with identical skill bodies remain ambiguous", async () => {
  if (!isolatedNativeHost) return;
  const result = await runPagedCodex(
    roots,
    pagedSkillPages.map((text) => ({ text })),
    { aliases: ["other"] },
  );
  expect(
    result.observations?.find(
      (item) => item.id === "sevro.host.skill-activations",
    ),
  ).toMatchObject({
    completeness: "partial",
    data: { observedSkills: [], ambiguousSkills: ["other", "probe"] },
  });
});

test("repeated page text cannot prove different body positions were exposed", async () => {
  if (!isolatedNativeHost) return;
  const repeated =
    "Read this repeated instruction before any subsequent action.\n";
  const result = await runPagedCodex(
    roots,
    [{ text: repeated }, { text: repeated }],
    {
      body: repeated.repeat(3),
    },
  );
  expect(
    result.observations?.find(
      (item) => item.id === "sevro.host.skill-activations",
    ),
  ).toMatchObject({
    completeness: "partial",
    data: { observedSkills: [], partialSkills: ["probe"] },
  });
});

test.each([
  "repeat\n",
  "Read this repeated instruction before any subsequent action.\n",
])("paged matching limits keep evidence unknown: %j", async (line) => {
  if (!isolatedNativeHost) return;
  const result = await runPagedCodex(roots, [{ text: line }], {
    body: line.repeat(5000),
  });
  expect(
    result.observations?.find(
      (item) => item.id === "sevro.host.skill-activations",
    ),
  ).toMatchObject({
    completeness: "partial",
    data: { observedSkills: [] },
  });
});
