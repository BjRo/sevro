import { expect, test } from "bun:test";
import { claudeHostSettings } from "../../../src/hosts/index";

test.each([false, true])("Claude settings JSON with runtime %s", (runtime) => {
  expect(
    JSON.stringify(
      claudeHostSettings(
        "/state/private",
        "/state/private/config/credential.json",
        ["/plugins", "/plugins"],
        ["/source"],
        runtime
          ? {
              format: "sevro.runtime.v1",
              environment: {},
              readOnlyRoots: ["/tools"],
              hooks: { plugins: ["probe"] },
            }
          : undefined,
        ["/transcripts", "/artifacts"],
        runtime
          ? {
              root: "/runtime",
              workspace: "/workspace",
              cacheRoots: ["/cache"],
            }
          : undefined,
        "/workspace",
      ),
    ),
  ).toMatchSnapshot();
});
