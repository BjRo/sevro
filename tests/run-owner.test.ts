import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkpointRunOwner, startRunOwner } from "../src/run-owner";

const roots: string[] = [];
const digest = "a".repeat(64);
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture() {
  const stateRoot = await mkdtemp(join(tmpdir(), "sevro-owner-"));
  roots.push(stateRoot);
  const attemptId = randomUUID();
  return {
    stateRoot,
    evaluationDigest: digest,
    attemptId,
    activeRunPath: join(stateRoot, "active", `${attemptId}.json`),
    checkpointPath: join(stateRoot, attemptId, "checkpoint.json"),
    evidenceDirectory: join(stateRoot, attemptId),
    artifactPath: join(stateRoot, "results", attemptId, "run.json"),
  };
}

test("a live owner blocks an equivalent run until finalization", async () => {
  if (process.platform === "win32") return;
  const paths = await fixture();
  const first = startRunOwner(paths);
  expect(() => startRunOwner({ ...paths, attemptId: randomUUID() })).toThrow(
    /still active|is active/,
  );
  checkpointRunOwner(
    first,
    [{ trial: 1, artifactPath: "/tmp/trial.json" }],
    "complete",
  );
  const secondId = randomUUID();
  const second = startRunOwner({
    ...paths,
    attemptId: secondId,
    activeRunPath: join(paths.stateRoot, "active", `${secondId}.json`),
    checkpointPath: join(paths.stateRoot, secondId, "checkpoint.json"),
    evidenceDirectory: join(paths.stateRoot, secondId),
  });
  expect(second.claim.attemptId).toBe(secondId);
  expect(JSON.parse(await readFile(paths.activeRunPath, "utf8")).status).toBe(
    "complete",
  );
});

test("an unverifiable owner is refused and a changed process start can be reclaimed", async () => {
  if (process.platform === "win32") return;
  const paths = await fixture();
  const first = startRunOwner(paths);
  const ownerPath = first.claimPath;
  const claim = JSON.parse(await readFile(ownerPath, "utf8"));
  await writeFile(ownerPath, JSON.stringify({ ...claim, owner: null }));
  expect(() => startRunOwner({ ...paths, attemptId: randomUUID() })).toThrow(
    /unverifiable/,
  );
  await writeFile(
    ownerPath,
    JSON.stringify({
      ...claim,
      owner: { ...claim.owner, startedAt: "different process start" },
    }),
  );
  const nextId = randomUUID();
  const next = startRunOwner({
    ...paths,
    attemptId: nextId,
    activeRunPath: join(paths.stateRoot, "active", `${nextId}.json`),
    checkpointPath: join(paths.stateRoot, nextId, "checkpoint.json"),
    evidenceDirectory: join(paths.stateRoot, nextId),
  });
  expect(next.claim.attemptId).toBe(nextId);
  expect(JSON.parse(await readFile(paths.activeRunPath, "utf8")).status).toBe(
    "interrupted",
  );
  expect(
    JSON.parse(
      await readFile(join(paths.evidenceDirectory, "run-owner.json"), "utf8"),
    ).status,
  ).toBe("interrupted");
});

test("an abruptly killed owner can be reclaimed without losing its attempt record", async () => {
  if (process.platform === "win32") return;
  const paths = await fixture();
  const ready = join(paths.stateRoot, "ready");
  const childScript = join(paths.stateRoot, "child.ts");
  await writeFile(
    childScript,
    `import { writeFileSync } from "node:fs";
import { startRunOwner } from ${JSON.stringify(join(import.meta.dir, "../src/run-owner.ts"))};
startRunOwner(${JSON.stringify(paths)});
writeFileSync(${JSON.stringify(ready)}, "ready");
setInterval(() => {}, 1000);
`,
  );
  const child = Bun.spawn([process.execPath, childScript], {
    stdout: "ignore",
    stderr: "pipe",
  });
  try {
    const deadline = Date.now() + 5000;
    while (!(await Bun.file(ready).exists())) {
      if (Date.now() > deadline) throw new Error("child owner did not start");
      await Bun.sleep(20);
    }
  } finally {
    child.kill("SIGKILL");
    await child.exited;
  }
  const nextId = randomUUID();
  const next = startRunOwner({
    ...paths,
    attemptId: nextId,
    activeRunPath: join(paths.stateRoot, "active", `${nextId}.json`),
    checkpointPath: join(paths.stateRoot, nextId, "checkpoint.json"),
    evidenceDirectory: join(paths.stateRoot, nextId),
  });
  expect(next.claim.attemptId).toBe(nextId);
  expect(JSON.parse(await readFile(paths.activeRunPath, "utf8")).status).toBe(
    "interrupted",
  );
  expect(
    await Bun.file(join(paths.evidenceDirectory, "run-owner.json")).exists(),
  ).toBeTrue();
});
