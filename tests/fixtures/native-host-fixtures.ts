import { mkdir, readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHostDiagnostics } from "../../src/host-diagnostics";
import { type AppServerRunOptions } from "../../src/hosts/codex-app-server";
import { record } from "./assertions";
import { createTemporaryFixtures } from "./filesystem";

const testDirectory = join(import.meta.dir, "..");

export function createWorkspace(roots: string[]) {
  const { temporaryFixture } = createTemporaryFixtures(roots);

  async function workspace() {
    const root = await realpath(
      await temporaryFixture(join(tmpdir(), "sevro-host-quality-")),
    );

    await mkdir(join(root, ".git"));
    return root;
  }
  return workspace;
}

export function createServerOptions(
  workspace: ReturnType<typeof createWorkspace>,
) {
  async function serverOptions(mode: string): Promise<AppServerRunOptions> {
    const root = await workspace();
    return {
      diagnostics: createHostDiagnostics("codex", false, {}),
      request: {
        repoDir: root,
        prompt: "Return ready",
        model: "synthetic",
        effort: "low",
        control: { appServerTimeoutMs: 2000 },
      },
      argv: [
        process.execPath,
        join(testDirectory, "fixtures/host-app-server.ts"),
        mode,
      ],
      env: {},
      permissionProfile: "test_profile",
      followUpBoundary: () =>
        Promise.resolve(
          JSON.stringify({
            type: "sevro.follow_up_boundary",
            thread_id: "root",
          }),
        ),
    };
  }
  return serverOptions;
}

export async function peerEvents(
  root: string,
): Promise<Record<string, unknown>[]> {
  const text = await readFile(join(root, ".git/peer-events.jsonl"), "utf8");
  return text
    .trim()
    .split("\n")
    .map((line) => record(JSON.parse(line)));
}
