import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixtureBinDirectory } from "../src/fixture-bin";

test("fixture binary PATH refuses a Git directory redirected outside the workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "sevro-bin-boundary-"));
  try {
    const workspace = join(root, "workspace");
    const outside = join(root, "outside");
    await Promise.all([
      mkdir(workspace),
      mkdir(join(outside, "fixture-bin"), { recursive: true }),
    ]);
    await symlink(outside, join(workspace, ".git"));
    await expect(fixtureBinDirectory(workspace)).rejects.toThrow(
      /escapes the workspace/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
