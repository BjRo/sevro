import { afterEach, expect, test } from "bun:test";
import { realpath, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { defined } from "../../fixtures/assertions";
import { createTemporaryFixtures } from "../../fixtures/filesystem";
import { localHttpProbe } from "../../fixtures/local-http";
import { createCodexFixture } from "../../fixtures/runtime-host-fixtures";

const roots: string[] = [];

const { cleanupTemporaryFixtures } = createTemporaryFixtures(roots);
afterEach(cleanupTemporaryFixtures);

const codexFixture = createCodexFixture(roots);

test.each([false, true])(
  "Codex candidate local HTTP opt-in runs a real server with outbound TCP denied, Codex state %s",
  async (codexState) => {
    const { host, workspace } = await codexFixture(
      'if test -n "$SEVRO_CODEX_AGENT_SKILLS"; then test -s "$CODEX_HOME/config.toml" && ! cat "$CODEX_HOME/auth.json" >/dev/null 2>&1 || exit 81; fi; node http-probe.cjs',
    );
    const node = await realpath(defined(Bun.which("node")));
    await writeFile(join(workspace, "http-probe.cjs"), localHttpProbe);
    const result = await host.run({
      prompt: "Run the local HTTP test",
      workspace,
      condition: "passive",
      runtimePolicy: {
        format: "sevro.runtime.v1",
        codexState,
        network: { localHttp: true },
        environment: { PATH: `${dirname(node)}:/usr/bin:/bin` },
        readOnlyRoots: [
          dirname(dirname(node)),
          ...(process.platform === "darwin" ? ["/System/Library/OpenSSL"] : []),
        ],
      },
    });
    expect(result.complete).toBe(true);
    expect(result.finalMessage).toBe("local-http-ok");
  },
);

test.each(["semantic", "advisory"] as const)(
  "Codex local HTTP selection leaves the %s role network disabled",
  async (runtimeRole) => {
    const { host, workspace } = await codexFixture(
      "node http-probe.cjs denied",
    );
    const node = await realpath(defined(Bun.which("node")));
    await writeFile(join(workspace, "http-probe.cjs"), localHttpProbe);
    const result = await host.run({
      prompt: "Run the network boundary probe",
      workspace,
      runtimeRole,
      condition: "passive",
      runtimePolicy: {
        format: "sevro.runtime.v1",
        network: { localHttp: true },
        environment: { PATH: `${dirname(node)}:/usr/bin:/bin` },
        readOnlyRoots: [
          dirname(dirname(node)),
          ...(process.platform === "darwin" ? ["/System/Library/OpenSSL"] : []),
        ],
      },
    });
    expect(result.complete).toBe(true);
    expect(result.finalMessage).toBe("bind-denied");
  },
);
