import { afterEach, expect, test } from "bun:test";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createIsolationPolicy,
  linuxSandboxArguments,
  macSandboxProfile,
} from "../../../src/isolation/index";
import { createTemporaryFixtures } from "../../fixtures/filesystem";

const { temporaryFixture, cleanupTemporaryFixtures } =
  createTemporaryFixtures();
afterEach(cleanupTemporaryFixtures);
const roots = ["/protected/source", "/protected/state", "/protected/source"];
test.each([false, true])(
  "SBPL output with local HTTP %s",
  async (localHttp) => {
    const cache = await realpath(
      await temporaryFixture(join(tmpdir(), "sevro-golden-cache-")),
    );
    const policy = await createIsolationPolicy({
      subject: "host",
      workspace: "/workspace",
      privateStateRoot: "/protected/state",
      protectedRoots: roots,
      network: localHttp ? "local-http" : "deny",
      readOnlyRoots: ["/tools"],
      writableRuntimeRoot: "/protected/state/runtime",
      nativeReadRoots: [],
      transcriptReadRoots: ["/protected/state/view"],
      writableCacheRoots: [cache],
    });
    expect(macSandboxProfile(policy)).toMatchSnapshot();
  },
);
test("bwrap argument output", async () => {
  const cache = await realpath(
    await temporaryFixture(join(tmpdir(), "sevro-golden-cache-")),
  );
  const policy = await createIsolationPolicy({
    subject: "host",
    workspace: "/workspace",
    privateStateRoot: "/protected/state",
    protectedRoots: roots,
    network: "deny",
    readOnlyRoots: ["/tools"],
    transcriptReadRoots: ["/transcripts"],
    candidateArtifactRoots: { reports: "/artifacts" },
    hookReadRoots: ["/plugins"],
    writableRuntimeRoot: "/protected/state/runtime",
    writableCacheRoots: [cache],
  });
  expect(
    linuxSandboxArguments(
      policy,
      ["/bin/sh", "-c", "true"],
      [
        "--tmpfs",
        "/protected/source",
        "--chmod",
        "0111",
        "/protected/source",
        "--ro-bind",
        "/blocked",
        "/protected/file",
      ],
    ).map((value) => (value === cache ? "/cache" : value)),
  ).toMatchSnapshot();
});
