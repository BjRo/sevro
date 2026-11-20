import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import {
  candidateGrantEnvironment,
  candidateGrantReadRoots,
  prepareRoleEnvironment,
  rolePath,
} from "../../../src/runtime/index";
import { createTemporaryFixtures } from "../../fixtures/filesystem";

const { temporaryFixture, cleanupTemporaryFixtures } =
  createTemporaryFixtures();
afterEach(cleanupTemporaryFixtures);

async function workspaceFixture() {
  const root = await realpath(
    await temporaryFixture(join(tmpdir(), "sevro-role-environment-")),
  );
  const workspace = join(root, "workspace");
  await mkdir(join(workspace, ".git"), { recursive: true });
  return { root, workspace, runtimeRoot: join(root, "state", "runtime") };
}

test("role PATH puts fixture tools and the toolchain before the declared PATH", () => {
  expect(
    rolePath("command", {
      fixtureBinDir: "/fixture",
      toolchainBinDir: "/toolchain",
      declared: "/declared",
    }),
  ).toBe(["/fixture", "/toolchain", "/declared"].join(delimiter));
});

test("each role process keeps its own fallback PATH", () => {
  expect(rolePath("command", {})).toBe("/usr/bin:/bin:/usr/sbin:/sbin");
  expect(rolePath("host-command", {})).toBe(
    "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
  );
  expect(rolePath("native-host", {})).toBe(process.env.PATH ?? "/usr/bin:/bin");
});

test("candidate grants name transcripts and artifacts for graders", () => {
  const grants = {
    transcriptRoot: "/transcripts",
    artifactRoots: { reviews: "/home/.darrow/reviews" },
  };
  expect(candidateGrantEnvironment(grants)).toEqual({
    SEVRO_CANDIDATE_TRANSCRIPTS: "/transcripts",
    SEVRO_CANDIDATE_ARTIFACT_REVIEWS: "/home/.darrow/reviews",
  });
  expect(candidateGrantReadRoots(grants)).toEqual([
    "/transcripts",
    "/home/.darrow/reviews",
  ]);
  expect(candidateGrantEnvironment({})).toEqual({});
});

test("checks without a runtime policy keep the legacy private layout", async () => {
  const { workspace, runtimeRoot } = await workspaceFixture();
  const { runtime, environment } = await prepareRoleEnvironment({
    workspace,
    policy: undefined,
    role: "checks",
    root: runtimeRoot,
    uvRuntimeCache: true,
  });
  expect(runtime.declared).toBe(false);
  expect(existsSync(join(runtimeRoot, "check-home"))).toBe(true);
  expect(environment).toMatchObject({
    HOME: join(runtimeRoot, "check-home"),
    TMPDIR: join(runtimeRoot, "check-tmp"),
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    UV_CACHE_DIR: join(workspace, ".git", "sevro-runtime", "uv-cache"),
    UV_PROJECT_ENVIRONMENT: join(runtimeRoot, "project-environment"),
    UV_OFFLINE: "1",
  });
});

test("a declared runtime policy supplies the environment and its runtime root", async () => {
  const { workspace, runtimeRoot } = await workspaceFixture();
  const { runtime, environment } = await prepareRoleEnvironment({
    workspace,
    policy: {
      format: "sevro.runtime.v1",
      environment: { PATH: "{{sevro.runtime}}/bin", SAMPLE: "value" },
      readOnlyRoots: [],
    },
    role: "checks",
    root: runtimeRoot,
    fixtureBinDir: "/fixture",
  });
  const root = await realpath(runtimeRoot);
  expect(runtime).toMatchObject({ declared: true, root });
  expect(environment).toMatchObject({
    SAMPLE: "value",
    HOME: join(root, "home"),
    TMPDIR: join(root, "tmp"),
    PATH: ["/fixture", join(root, "bin")].join(delimiter),
  });
  expect(environment).not.toHaveProperty("UV_CACHE_DIR");
});
