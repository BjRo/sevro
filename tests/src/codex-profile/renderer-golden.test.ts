import { expect, test } from "bun:test";
import { codexPermissionProfile } from "../../../src/codex-profile/index";

test.each([false, true])(
  "Codex TOML output with local HTTP %s",
  (localHttp) => {
    expect(
      platformIndependent(
        codexPermissionProfile({
          id: "sevro_golden",
          workspace: "/workspace",
          commandHome: "/state/home",
          commandTemp: "/state/tmp",
          executableReadRoots: ["/tools", "/tools"],
          protectedRoots: ["/source", "/state"],
          pluginReadRoot: "/state/plugins",
          runtimeReadRoots: ["/runtime-tools"],
          nativeReadRoots: ["/state/view"],
          nativeWriteRoots: ["/state/skills", "/cache"],
          runtimeWriteRoot: "/state/runtime",
          localHttp,
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
