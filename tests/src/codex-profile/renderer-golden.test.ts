import { expect, test } from "bun:test";
import { createIsolationPolicy } from "../../../src/isolation/index";
import { codexPermissionProfile } from "../../../src/codex-profile/index";

test.each([false, true])(
  "Codex TOML output with local HTTP %s",
  async (localHttp) => {
    expect(
      platformIndependent(
        codexPermissionProfile({
          id: "sevro_golden",
          policy: await createIsolationPolicy({
            subject: "host",
            privateStateRoot: "/state",
            workspace: "/workspace",
            commandHome: "/state/home",
            commandTemp: "/state/tmp",
            executableReadRoots: ["/tools", "/tools"],
            protectedRoots: ["/source", "/state"],
            pluginReadRoots: ["/state/plugins"],
            readOnlyRoots: ["/runtime-tools"],
            nativeReadRoots: ["/state/view"],
            nativeWriteRoots: ["/state/skills", "/cache"],
            writableRuntimeRoot: "/state/runtime",
            network: localHttp ? "local-http" : "deny",
          }),
          commandEnvironment: { PATH: "/tools:/bin", LANG: "C" },
        }),
      ),
    ).toMatchSnapshot();
  },
);

// Codex adds executable PATH entries on Linux and denies two temp aliases on macOS.
function platformIndependent(profile: string): string {
  return profile
    .replace('PATH = "/tools:/tools:/tools:/bin"', 'PATH = "/tools:/bin"')
    .replace('":tmpdir" = "deny"\n', "")
    .replace('":slash_tmp" = "deny"\n', "");
}
