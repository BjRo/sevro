import { afterEach, expect, test } from "bun:test";
import {
  completeProbeBody,
  isolatedNativeHost,
  pagedSkillPages,
  runPagedCodex,
  sharedSkillParagraph,
  siblingSkillBody,
} from "../../fixtures/codex-host";
import { createTemporaryFixtures } from "../../fixtures/filesystem";

const roots: string[] = [];
const { cleanupTemporaryFixtures } = createTemporaryFixtures(roots);
afterEach(cleanupTemporaryFixtures);

test("Codex separates full and absent skill exposure from collection health", async () => {
  if (!isolatedNativeHost) return;
  const result = await runPagedCodex(roots, [{ text: completeProbeBody }], {
    body: completeProbeBody,
    siblings: { sibling: siblingSkillBody },
  });
  expect(
    result.observations?.find(
      (item) => item.id === "sevro.host.skill-activations",
    ),
  ).toMatchObject({
    completeness: "complete",
    data: {
      collectionStatus: "complete",
      skillExposures: [
        { skill: "probe", status: "full" },
        { skill: "sibling", status: "none" },
      ],
    },
  });
});

test("Codex reports partial exposure without implying a collection failure", async () => {
  if (!isolatedNativeHost) return;
  const result = await runPagedCodex(roots, [{ text: pagedSkillPages[0] }], {
    siblings: { sibling: siblingSkillBody },
  });
  expect(
    result.observations?.find(
      (item) => item.id === "sevro.host.skill-activations",
    ),
  ).toMatchObject({
    completeness: "partial",
    data: {
      collectionStatus: "complete",
      skillExposures: [
        { skill: "probe", status: "partial" },
        { skill: "sibling", status: "none" },
      ],
      observedSkills: [],
      incompleteReasons: ["partial_skill_bodies"],
    },
  });
});

test.each([
  {
    label: "earlier pending call",
    pages: [{ text: "gap", omitPost: true }, { text: completeProbeBody }],
    options: {},
  },
  {
    label: "missing stop",
    pages: [{ text: completeProbeBody }],
    options: { omitStop: true },
  },
])(
  "Codex preserves full exposure with unknown absence after $label",
  async ({ pages, options }) => {
    if (!isolatedNativeHost) return;
    const result = await runPagedCodex(roots, pages, {
      ...options,
      body: completeProbeBody,
      siblings: { sibling: siblingSkillBody },
    });
    expect(
      result.observations?.find(
        (item) => item.id === "sevro.host.skill-activations",
      ),
    ).toMatchObject({
      completeness: "partial",
      data: {
        collectionStatus: "partial",
        primarySkill: null,
        primarySkillCompleteness: "partial",
        skillExposures: [
          { skill: "probe", status: "full" },
          { skill: "sibling", status: "unknown" },
        ],
      },
    });
  },
);

test("Codex distinguishes ambiguous bodies from absent exposure", async () => {
  if (!isolatedNativeHost) return;
  const result = await runPagedCodex(
    roots,
    [{ text: pagedSkillPages.join("") }],
    {
      aliases: ["other"],
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
      collectionStatus: "complete",
      skillExposures: [
        { skill: "other", status: "ambiguous" },
        { skill: "probe", status: "ambiguous" },
        { skill: "sibling", status: "none" },
      ],
    },
  });
  expect(
    result.observations?.some(
      (item) => item.id === "sevro.host.skill-exposure-claims",
    ),
  ).toBe(false);
});

test("Codex reports unavailable collection without claiming no exposure", async () => {
  if (!isolatedNativeHost) return;
  const result = await runPagedCodex(roots, [], {
    omitStart: true,
    omitStop: true,
  });
  expect(
    result.observations?.find(
      (item) => item.id === "sevro.host.skill-activations",
    ),
  ).toMatchObject({
    completeness: "partial",
    data: {
      collectionStatus: "unavailable",
      skillExposures: [{ skill: "probe", status: "unknown" }],
    },
  });
  expect(
    result.observations?.some(
      (item) => item.id === "sevro.host.skill-exposure-claims",
    ),
  ).toBe(false);
});

test.each([
  { label: "full", text: completeProbeBody, status: "full" },
  { label: "partial", text: pagedSkillPages[0], status: "partial" },
])(
  "Codex publishes complete positive exposure claims for $label reads across gaps",
  async ({ text, status }) => {
    if (!isolatedNativeHost) return;
    const result = await runPagedCodex(
      roots,
      [{ text: "gap", omitPost: true }, { text }],
      { body: completeProbeBody, siblings: { sibling: siblingSkillBody } },
    );
    expect(result.observations).toContainEqual({
      id: "sevro.host.skill-exposure-claims",
      completeness: "complete",
      data: {
        method: "tool_result_body_match",
        scope: "positive_exposure",
        collectionStatus: "partial",
        skillExposures: [{ skill: "probe", status }],
      },
    });
    expect(
      result.observations?.some(
        (item) => item.id === "sevro.host.skill-activation-claims",
      ),
    ).toBe(false);
    expect(JSON.stringify(result.observations)).not.toContain(
      pagedSkillPages[0],
    );
  },
);

test("Codex activation evidence explains an unmatched tool hook without losing skill credit", async () => {
  if (!isolatedNativeHost) return;
  const result = await runPagedCodex(
    roots,
    [
      { text: completeProbeBody },
      { text: "policy-rejected private command", omitPost: true },
    ],
    { body: completeProbeBody },
  );
  expect(result.complete).toBe(true);
  const observation = result.observations?.find(
    (item) => item.id === "sevro.host.skill-activations",
  );
  expect(observation).toMatchObject({
    completeness: "partial",
    data: {
      observedSkills: ["probe"],
      partialSkills: [],
      incompleteReasons: ["pending_tool_calls"],
      collection: {
        eventCount: 5,
        preToolUseCount: 2,
        postToolUseCount: 1,
        pendingToolCallCount: 1,
      },
    },
  });
  expect(JSON.stringify(observation)).not.toContain("private command");
});

test("Codex preserves a proven primary activation before a later hook gap", async () => {
  if (!isolatedNativeHost) return;
  const result = await runPagedCodex(
    roots,
    [{ text: completeProbeBody }, { text: "rejected", omitPost: true }],
    { body: completeProbeBody },
  );
  expect(
    result.observations?.find(
      (item) => item.id === "sevro.host.skill-activations",
    ),
  ).toMatchObject({
    completeness: "partial",
    data: {
      primarySkill: "probe",
      primarySkillCompleteness: "complete",
      incompleteReasons: ["pending_tool_calls"],
    },
  });
});

test("Codex publishes complete primary claims without completing collection", async () => {
  if (!isolatedNativeHost) return;
  const result = await runPagedCodex(
    roots,
    [{ text: completeProbeBody }, { text: "rejected", omitPost: true }],
    { body: completeProbeBody },
  );
  expect(result.observations).toContainEqual({
    id: "sevro.host.skill-activation-claims",
    completeness: "complete",
    data: {
      method: "tool_result_body_match",
      scope: "primary_and_positive_presence",
      collectionCompleteness: "partial",
      primarySkill: "probe",
      presentSkills: ["probe"],
    },
  });
});

test("Codex cannot establish primary selection across an earlier hook gap", async () => {
  if (!isolatedNativeHost) return;
  const result = await runPagedCodex(
    roots,
    [{ text: "unobserved", omitPost: true }, { text: completeProbeBody }],
    { body: completeProbeBody },
  );
  expect(
    result.observations?.find(
      (item) => item.id === "sevro.host.skill-activations",
    ),
  ).toMatchObject({
    completeness: "partial",
    data: {
      observedSkills: ["probe"],
      primarySkill: null,
      primarySkillCompleteness: "partial",
    },
  });
  expect(
    result.observations?.some(
      (item) => item.id === "sevro.host.skill-activation-claims",
    ),
  ).toBe(false);
});

test("Codex keeps primary unknown when one completed result exposes multiple bodies", async () => {
  if (!isolatedNativeHost) return;
  const result = await runPagedCodex(
    roots,
    [{ text: siblingSkillBody + completeProbeBody }],
    { body: completeProbeBody, siblings: { sibling: siblingSkillBody } },
  );
  expect(
    result.observations?.find(
      (item) => item.id === "sevro.host.skill-activations",
    ),
  ).toMatchObject({
    completeness: "complete",
    data: {
      observedSkills: ["probe", "sibling"],
      primarySkill: null,
      primarySkillCompleteness: "partial",
    },
  });
});

test("Codex activation calls retain fragment-only and pending hook evidence", async () => {
  if (!isolatedNativeHost) return;
  const result = await runPagedCodex(
    roots,
    [
      { text: completeProbeBody },
      { text: sharedSkillParagraph },
      { text: "private rejected output", omitPost: true },
    ],
    { body: completeProbeBody, siblings: { sibling: siblingSkillBody } },
  );
  const observation = result.observations?.find(
    (item) => item.id === "sevro.host.skill-activations",
  );
  expect(observation).toMatchObject({
    completeness: "partial",
    data: {
      observedSkills: ["probe"],
      partialSkills: ["sibling"],
      calls: [
        {
          event: "PostToolUse",
          toolUseId: "page-0",
          invocations: ["probe"],
          fragmentSkills: [],
        },
        {
          event: "PostToolUse",
          toolUseId: "page-1",
          invocations: [],
          fragmentSkills: ["probe", "sibling"],
        },
        {
          event: "PreToolUse",
          toolUseId: "page-2",
          invocations: [],
          fragmentSkills: [],
        },
      ],
    },
  });
  for (const privateValue of [
    "bodyRanges",
    "sha256",
    sharedSkillParagraph,
    "private rejected output",
  ])
    expect(JSON.stringify(observation)).not.toContain(privateValue);
});

test.each([
  {
    name: "missing session start",
    options: { omitStart: true },
    reasons: ["session_start_missing"],
  },
  {
    name: "missing session stop",
    options: { omitStop: true },
    reasons: ["session_stop_missing"],
  },
  {
    name: "fragment-only output",
    options: { siblings: { sibling: siblingSkillBody } },
    reasons: ["partial_skill_bodies"],
  },
  {
    name: "ambiguous bodies",
    options: { aliases: ["alias"] },
    reasons: ["ambiguous_skill_bodies"],
  },
  {
    name: "orphan post hook",
    options: {
      hookEvents: [
        {
          event: "PostToolUse",
          fields: { tool_use_id: "orphan", tool_name: "Bash" },
        },
      ],
    },
    reasons: ["unmatched_post_tool_use"],
  },
  {
    name: "duplicate pre hook",
    options: {
      hookEvents: [
        {
          event: "PreToolUse",
          fields: { tool_use_id: "page-0", tool_name: "Bash" },
        },
        {
          event: "PostToolUse",
          fields: { tool_use_id: "page-0", tool_name: "Bash" },
        },
      ],
    },
    reasons: ["duplicate_tool_calls"],
  },
  {
    name: "invalid hook identity",
    options: {
      hookEvents: [
        {
          event: "PostToolUse",
          fields: { tool_use_id: "orphan", tool_name: null },
        },
      ],
    },
    reasons: ["unmatched_post_tool_use", "partial_hook_events"],
  },
  {
    name: "observer failure",
    options: {
      hookEvents: [{ event: "PostToolUse", fields: { hook_event_name: null } }],
    },
    reasons: ["observer_failure"],
  },
])(
  "Codex partial collection exposes reasons: $name",
  async ({ options, reasons }) => {
    if (!isolatedNativeHost) return;
    const result = await runPagedCodex(
      roots,
      [{ text: completeProbeBody }, { text: sharedSkillParagraph }],
      { body: completeProbeBody, ...options },
    );
    const observation = result.observations?.find(
      (item) => item.id === "sevro.host.skill-activations",
    );
    expect(observation).toMatchObject({
      completeness: "partial",
      data: {
        incompleteReasons: reasons,
        collection: { pendingToolCallCount: 0 },
      },
    });
  },
);
