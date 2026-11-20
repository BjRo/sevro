import { afterEach, expect, test } from "bun:test";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeHostSettings } from "../../../src/hosts/index";
import { createIsolationPolicy } from "../../../src/isolation/index";
import { createTemporaryFixtures } from "../../fixtures/filesystem";

const { temporaryFixture, cleanupTemporaryFixtures } =
  createTemporaryFixtures();
afterEach(cleanupTemporaryFixtures);
test.each([false, true])(
  "Claude settings JSON with runtime %s",
  async (runtime) => {
    const cache = await realpath(
      await temporaryFixture(join(tmpdir(), "sevro-golden-cache-")),
    );
    const policy = await createIsolationPolicy({
      subject: "host",
      workspace: "/workspace",
      privateStateRoot: "/state/private",
      protectedRoots: ["/source"],
      pluginReadRoots: ["/plugins", "/plugins"],
      runtimePolicy: runtime
        ? {
            format: "sevro.runtime.v1",
            environment: {},
            readOnlyRoots: ["/tools"],
            hooks: { plugins: ["probe"] },
          }
        : undefined,
      transcriptReadRoots: ["/transcripts", "/artifacts"],
      writableRuntimeRoot: runtime ? "/runtime" : undefined,
      writableCacheRoots: runtime ? [cache] : [],
    });
    expect(
      JSON.stringify(
        claudeHostSettings(policy, "/state/private/config/credential.json"),
      ).replaceAll(cache, "/cache"),
    ).toMatchSnapshot();
  },
);
