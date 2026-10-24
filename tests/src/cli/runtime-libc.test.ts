import { afterEach, expect, test } from "bun:test";
import {
  mkdir,
  readFile,
  realpath,
  symlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createTemporaryFixtures } from "../../fixtures/filesystem";
import {
  fixture,
  invoke,
  libcCheck,
  libcEnvironmentCheck,
  libcProbe,
} from "../../fixtures/runtime-cli";

const roots: string[] = [];
const { temporaryFixture, cleanupTemporaryFixtures } =
  createTemporaryFixtures(roots);
afterEach(cleanupTemporaryFixtures);

test.skipIf(process.platform !== "darwin")(
  "macOS read grants permit libc canonicalization with bounded ancestor visibility",
  // eslint-disable-next-line max-lines-per-function -- Keep the synthetic grants, public CLI invocation and isolation assertions in one regression scenario.
  async () => {
    const { root, project, args } = await fixture(roots);
    const supportBase = await realpath(
      await temporaryFixture(join(homedir(), ".sevro-libc-grants-")),
    );

    const parent = join(supportBase, 'ancestor "quoted"');
    const support = join(parent, "support");
    const peer = join(parent, "support-peer");
    await mkdir(support, { recursive: true });
    await mkdir(peer);
    const aliasParent = join(supportBase, "aliases");
    const alias = join(aliasParent, "selected");
    await mkdir(aliasParent);
    await symlink(support, alias);
    await symlink(peer, join(support, "escape"));
    await writeFile(join(support, "public.txt"), "public data");
    await writeFile(join(parent, "private.txt"), "private data");
    const binary = await libcProbe(join(root, "probe"));
    const outside = Bun.spawnSync([binary, "realpath", support]);
    expect(outside.exitCode, outside.stdout.toString()).toBe(0);
    expect(outside.stdout.toString().trim()).toBe(support);
    const checks = [
      libcCheck(binary, "canonical", "realpath", support, support),
      libcCheck(binary, "alias-canonical", "realpath", alias, support),
      libcCheck(
        binary,
        "alias-ancestor-metadata",
        "stat",
        aliasParent,
        "metadata",
      ),
      libcCheck(binary, "alias-ancestor-list", "list", aliasParent, null),
      libcCheck(binary, "ancestor-metadata", "stat", parent, "metadata"),
      libcCheck(binary, "home-metadata", "stat", homedir(), "metadata"),
      libcCheck(binary, "ancestor-list", "list", parent, null),
      libcCheck(
        binary,
        "ancestor-content",
        "read",
        join(parent, "private.txt"),
        null,
      ),
      libcCheck(binary, "peer-metadata", "stat", peer, null),
      libcCheck(
        binary,
        "escaping-link",
        "realpath",
        join(support, "escape"),
        null,
      ),
      libcCheck(
        binary,
        "grant-content",
        "read",
        join(support, "public.txt"),
        "public data",
      ),
      libcCheck(
        binary,
        "grant-write",
        "write",
        join(support, "created.txt"),
        null,
      ),
    ];
    await writeFile(
      join(root, "case.json"),
      JSON.stringify({
        id: "libc-read-grant",
        prompt: "Return ready.",
        fixture: { files: {} },
        checks,
        requiredEvidence: [],
      }),
    );
    await writeFile(
      join(project, "sevro.json"),
      JSON.stringify({
        format: "sevro.runtime.v1",
        filesystem: { readOnlyRoots: [join(root, "probe"), support, alias] },
      }),
    );
    const run = await invoke([...args, "--shell-isolation"]);
    expect(run.code, JSON.stringify(run.result.cases)).toBe(0);
    expect(run.result.task.verdict).toBe("passed");
    expect(await readFile(join(parent, "private.txt"), "utf8")).toBe(
      "private data",
    );
    expect(await readFile(join(support, "public.txt"), "utf8")).toBe(
      "public data",
    );
  },
);

test.skipIf(process.platform !== "darwin")(
  "macOS private writable runtimes permit libc canonicalization with bounded ancestor visibility",
  // eslint-disable-next-line max-lines-per-function -- Keep the seeded private runtime, public CLI invocation and isolation assertions in one regression scenario.
  async () => {
    const { root, project, args } = await fixture(roots);
    const binary = await libcProbe(join(root, "probe"));
    const source = join(root, "seed");
    await mkdir(source);
    await writeFile(join(source, "public.txt"), "seeded data");
    const checks = [
      libcEnvironmentCheck(
        binary,
        "seed-canonical",
        "realpath",
        "$SEVRO_PROBE_DATA",
        "canonicalized",
      ),
      libcEnvironmentCheck(
        binary,
        "runtime-canonical",
        "realpath",
        "$SEVRO_PROBE_RUNTIME",
        "canonicalized",
      ),
      libcEnvironmentCheck(
        binary,
        "runtime-ancestor-metadata",
        "stat",
        "$SEVRO_PROBE_RUNTIME/..",
        "metadata",
      ),
      libcEnvironmentCheck(
        binary,
        "runtime-parent-metadata",
        "stat",
        "$SEVRO_PROBE_RUNTIME/../..",
        "metadata",
      ),
      libcEnvironmentCheck(
        binary,
        "runtime-ancestor-list",
        "list",
        "$SEVRO_PROBE_RUNTIME/..",
        null,
      ),
      libcEnvironmentCheck(
        binary,
        "runtime-write",
        "write",
        "$SEVRO_PROBE_DATA/created.txt",
        "writable",
      ),
      libcEnvironmentCheck(
        binary,
        "seed-content",
        "read",
        "$SEVRO_PROBE_DATA/public.txt",
        "seeded data",
      ),
      libcCheck(binary, "seed-source-metadata", "stat", source, null),
      libcCheck(
        binary,
        "seed-source-content",
        "read",
        join(source, "public.txt"),
        null,
      ),
    ];
    await writeFile(
      join(root, "case.json"),
      JSON.stringify({
        id: "libc-private-runtime",
        prompt: "Return ready.",
        fixture: { files: {} },
        checks,
        requiredEvidence: [],
      }),
    );
    await writeFile(
      join(project, "sevro.json"),
      JSON.stringify({
        format: "sevro.runtime.v1",
        environment: {
          set: {
            SEVRO_PROBE_DATA: "{{sevro.runtime}}/data",
            SEVRO_PROBE_RUNTIME: "{{sevro.runtime}}",
          },
        },
        filesystem: { readOnlyRoots: [join(root, "probe")] },
        runtime: {
          seedDirectories: [{ source, target: "data", roles: ["checks"] }],
        },
      }),
    );
    const run = await invoke([...args, "--shell-isolation"]);
    expect(run.code, JSON.stringify(run.result.cases)).toBe(0);
    expect(run.result.task.verdict).toBe("passed");
    expect(await readFile(join(source, "public.txt"), "utf8")).toBe(
      "seeded data",
    );
  },
);

test.skipIf(process.platform !== "darwin")(
  "macOS artifact grants permit libc canonicalization with bounded ancestor visibility",
  // eslint-disable-next-line max-lines-per-function -- Keep the leased artifact fixture, public CLI invocation and isolation assertions in one regression scenario.
  async () => {
    const { root, project, args } = await fixture(roots);
    const binary = await libcProbe(join(root, "probe"));
    await writeFile(
      join(root, "adapter.ts"),
      `import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
export default {id:'test.artifact',model:'synthetic',effort:'none',async run(request){
 const home=join(request.candidateRuntimeRoot,'home');
 await mkdir(join(home,'artifacts','nested'),{recursive:true});
 await mkdir(join(home,'artifacts','peer'));
 await writeFile(join(home,'artifacts','nested','public.txt'),'artifact data');
 await writeFile(join(home,'private.txt'),'private data');
 return {finalMessage:'ready',complete:true};
}};\n`,
    );
    const artifact = "$SEVRO_CANDIDATE_ARTIFACT_PROBE";
    const checks = [
      libcEnvironmentCheck(
        binary,
        "artifact-canonical",
        "realpath",
        artifact,
        "canonicalized",
      ),
      libcEnvironmentCheck(
        binary,
        "artifact-ancestor-metadata",
        "stat",
        `${artifact}/..`,
        "metadata",
      ),
      libcEnvironmentCheck(
        binary,
        "artifact-home-metadata",
        "stat",
        `${artifact}/../..`,
        "metadata",
      ),
      libcEnvironmentCheck(
        binary,
        "artifact-ancestor-list",
        "list",
        `${artifact}/..`,
        null,
      ),
      libcEnvironmentCheck(
        binary,
        "artifact-peer-metadata",
        "stat",
        `${artifact}/../peer`,
        null,
      ),
      libcEnvironmentCheck(
        binary,
        "artifact-private-content",
        "read",
        `${artifact}/../../private.txt`,
        null,
      ),
      libcEnvironmentCheck(
        binary,
        "artifact-content",
        "read",
        `${artifact}/public.txt`,
        "artifact data",
      ),
      libcEnvironmentCheck(
        binary,
        "artifact-write",
        "write",
        `${artifact}/created.txt`,
        null,
      ),
    ];
    await writeFile(
      join(root, "case.json"),
      JSON.stringify({
        id: "libc-artifact-grant",
        prompt: "Return ready.",
        fixture: { files: {} },
        checks,
        requiredEvidence: [],
      }),
    );
    await writeFile(
      join(project, "sevro.json"),
      JSON.stringify({
        format: "sevro.runtime.v1",
        filesystem: { readOnlyRoots: [join(root, "probe")] },
        runtime: {
          artifactDirectories: [{ name: "probe", path: "artifacts/nested" }],
        },
      }),
    );
    const run = await invoke([...args, "--shell-isolation"]);
    expect(run.code, JSON.stringify(run.result.cases)).toBe(0);
    expect(run.result.task.verdict).toBe("passed");
  },
);
