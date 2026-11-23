import { afterEach, expect, test } from "bun:test";
import { expectUnknown } from "../../fixtures/assertions";
import { submittedProgram } from "../../fixtures/codex-native-calls";
import { createTemporaryFixtures } from "../../fixtures/filesystem";

const roots: string[] = [];
const { cleanupTemporaryFixtures } = createTemporaryFixtures(roots);
afterEach(cleanupTemporaryFixtures);

const catalogPrograms = [
  'text("ready");',
  "text(ALL_TOOLS);",
  `const hits = ALL_TOOLS.filter(
    x => /readiness|assess.*spec|specification.*ready/i.test(x.name + " " + x.description)
  ); text(hits);`,
  `const names = ALL_TOOLS
    .filter(x => /skill|review|readiness|verify/i.test(x.name + " " + x.description))
    .map(x => ({ name: x.name, description: x.description.slice(0, 200) }));
  text(names);`,
  "const hits=ALL_TOOLS.filter(x=>/private catalog/.test(x.name)); const names=hits.map(x=>x.description.slice(5));text(names);",
];

test.each(catalogPrograms)(
  "Code Mode completely inspects metadata-only output: %s",
  async (input) => {
    const portable = await submittedProgram(roots, input, 0);
    expect(portable.completeness).toBe("complete");
    expectUnknown(portable.data).toMatchObject({
      acceptedAgentCount: 0,
      execCalls: [
        { completeness: "complete", inspectionReason: null, calls: [] },
      ],
    });
  },
);

test.each(catalogPrograms)(
  "Code Mode preserves launches beside catalog output: %s",
  async (input) => {
    const portable = await submittedProgram(
      roots,
      input + "await tools.spawn_agent({});",
      0,
    );
    expect(portable.completeness).toBe("complete");
    expectUnknown(portable.data).toMatchObject({
      acceptedAgentCount: 0,
      execCalls: [
        {
          completeness: "complete",
          calls: [
            { index: 0, namespace: "collaboration", name: "spawn_agent" },
          ],
        },
      ],
    });
    expect(JSON.stringify(portable)).not.toContain("private catalog");
  },
);

test.each([
  "ALL_TOOLS.filter(x => tools.spawn_agent({}));",
  "ALL_TOOLS.map(x => tools.spawn_agent({}));",
  "ALL_TOOLS.filter(x => unknown(x));",
  "ALL_TOOLS.filter(x => /a/.test(tools.spawn_agent({})));",
  "ALL_TOOLS.map(x => ({name: tools.spawn_agent({})}));",
  "ALL_TOOLS.map(x => x.description.slice(0, tools.spawn_agent({})));",
  "ALL_TOOLS.filter(x => /a/.test(x.name + tools.spawn_agent({})));",
  "ALL_TOOLS.filter(x => { tools.spawn_agent({}); return true; });",
  "ALL_TOOLS.filter(async x => /a/.test(x.name));",
  "ALL_TOOLS.filter((x=tools.spawn_agent({})) => /a/.test(x.name));",
  "ALL_TOOLS.filter(({name}) => /a/.test(name));",
  "ALL_TOOLS.filter(x => /a/.test(x.name), tools.spawn_agent({}));",
  "ALL_TOOLS.filter(x => x.name.match(/a/));",
  "ALL_TOOLS.filter(x => new RegExp('a').test(x.name));",
  "ALL_TOOLS.filter(tools.spawn_agent);",
  "ALL_TOOLS.filter();",
  "ALL_TOOLS.filter((x,y) => /a/.test(x.name));",
  "ALL_TOOLS.filter((...x) => /a/.test(x.name));",
  "ALL_TOOLS.filter(x => x.name);",
  "ALL_TOOLS.filter(x => unknown(x.name));",
  "ALL_TOOLS.filter(x => /a/.exec(x.name));",
  "ALL_TOOLS.filter(x => /a/.test());",
  "ALL_TOOLS.filter(x => /a/.test(x.name,x.description));",
  "ALL_TOOLS.filter(x => /a/.test(other.name));",
  "ALL_TOOLS.map(x => x.name - x.description);",
  "ALL_TOOLS.map(x => x.name + tools.spawn_agent({}));",
  "ALL_TOOLS.map(x => ({...x}));",
  "ALL_TOOLS.map(x => x.name.substring(0,1));",
  "ALL_TOOLS.map(x => unknown(x.name));",
  "ALL_TOOLS.map(x => x.name.slice());",
  "ALL_TOOLS.map(x => x.name.slice(9007199254740992));",
  "ALL_TOOLS.map(x => x.name.slice('0'));",
  "ALL_TOOLS.map(x => ({name:x.name})).filter(x => /a/.test(x.name));",
  "const names=ALL_TOOLS.map(x=>x.name);names.filter(x=>/a/.test(x.name));",
  "const filter=ALL_TOOLS.filter; filter(x=>tools.spawn_agent({}));",
  "const launch=tools.spawn_agent; text(ALL_TOOLS); launch({});",
  'text(ALL_TOOLS);tools["spawn_agent"]({});',
  'text(ALL_TOOLS);tools.exec({code:"tools.spawn_agent({})"});',
  "const ALL_TOOLS=[];text(ALL_TOOLS);",
  "const [ALL_TOOLS]=await Promise.all([]);text(ALL_TOOLS);",
  "ALL_TOOLS.filter(ALL_TOOLS => /a/.test(ALL_TOOLS.name));",
  "ALL_TOOLS.filter(tools => /a/.test(tools.name));",
  "ALL_TOOLS.map(x => x.constructor);",
  "ALL_TOOLS.map(x => x.name.slice(-1));",
  "ALL_TOOLS.map(x => x.name.slice(0, 1.5));",
  "ALL_TOOLS.map(x => x.name.slice(0, 1, 2));",
  "ALL_TOOLS.map(x => ({get name(){return tools.spawn_agent({});}}));",
  "ALL_TOOLS.map(x => ({[tools.spawn_agent({})]:x.name}));",
])("Code Mode keeps unsafe catalog source partial: %s", async (input) => {
  const portable = await submittedProgram(roots, input, 0);
  expect(portable.completeness).toBe("partial");
  expect(portable.data.acceptedAgentCount).toBeNull();
});

test("Code Mode applies the shared node budget inside catalog callbacks", async () => {
  const input =
    "text(ALL_TOOLS.map(x=>({" + "name:x.name,".repeat(2100) + "})));";
  const portable = await submittedProgram(roots, input, 0);
  expect(portable.completeness).toBe("partial");
  expect(portable.data.acceptedAgentCount).toBeNull();
});

test("Code Mode catalog queries do not consume submitted-call slots", async () => {
  const input =
    "text(ALL_TOOLS.filter(x=>/a/.test(x.name)));" +
    "await tools.get_goal({});".repeat(128);
  const portable = await submittedProgram(roots, input, 0);
  expect(portable.completeness).toBe("complete");
  expect(portable.data.execCalls?.[0]?.calls).toHaveLength(128);
  const exceeded = await submittedProgram(
    roots,
    input + "await tools.get_goal({});",
    0,
  );
  expect(exceeded.completeness).toBe("partial");
});
