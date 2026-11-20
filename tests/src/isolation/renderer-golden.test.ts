import { expect, test } from "bun:test";
import {
  linuxSandboxArguments,
  macSandboxProfile,
} from "../../../src/isolation/index";

const roots = ["/protected/source", "/protected/state", "/protected/source"];
test.each([false, true])("SBPL output with local HTTP %s", (localHttp) => {
  expect(
    macSandboxProfile(
      roots,
      true,
      ["/tools"],
      "/protected/state/runtime",
      ["/protected/state/view"],
      "/workspace",
      localHttp,
      ["/cache"],
    ),
  ).toMatchSnapshot();
});
test("bwrap argument output", () => {
  expect(
    linuxSandboxArguments(
      {
        argv: ["/bin/sh", "-c", "true"],
        workspace: "/workspace",
        protectedRoots: roots,
        privateStateRoot: "/protected/state",
        denyNetwork: true,
        transcriptReadRoots: ["/transcripts"],
        candidateArtifactRoots: { reports: "/artifacts" },
        hookReadRoots: ["/plugins"],
      },
      {
        workspace: "/workspace",
        masks: [
          "--tmpfs",
          "/protected/source",
          "--chmod",
          "0111",
          "/protected/source",
          "--ro-bind",
          "/blocked",
          "/protected/file",
        ],
        readRoots: ["/tools"],
        ownedRoot: "/protected/state/runtime",
        writableCacheRoots: ["/cache"],
      },
    ),
  ).toMatchSnapshot();
});
