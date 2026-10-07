import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkpointRunOwner, startRunOwner } from "../src/run-owner";
import { parseOwner, parseRecord } from "./fixtures/assertions";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function ownership() {
  const stateRoot = await mkdtemp(join(tmpdir(), "sevro-ownership-quality-"));
  roots.push(stateRoot);
  const attemptId = randomUUID();
  return {
    stateRoot,
    evaluationDigest: "c".repeat(64),
    attemptId,
    activeRunPath: join(stateRoot, "active", `${attemptId}.json`),
    checkpointPath: join(stateRoot, attemptId, "checkpoint.json"),
    evidenceDirectory: join(stateRoot, attemptId),
    artifactPath: join(stateRoot, "results", attemptId, "run.json"),
  };
}

const checkpointRefusals = [
  {
    name: "different attempt",
    fields: { attemptId: "foreign-attempt" },
    message: "ownership changed before checkpoint",
  },
  {
    name: "finalized claim",
    fields: { status: "complete" },
    message: "already finalized",
  },
  {
    name: "unverifiable owner",
    fields: { owner: null },
    message: "identity is no longer verifiable",
  },
];

for (const refusal of checkpointRefusals) {
  test(`refuses a checkpoint with ${refusal.name} and preserves retained evidence`, async () => {
    const paths = await ownership();
    const owner = startRunOwner(paths);
    const checkpoint = await readFile(paths.checkpointPath, "utf8");
    const active = await readFile(paths.activeRunPath, "utf8");
    const claim = JSON.stringify({
      ...parseRecord(await readFile(owner.claimPath, "utf8")),
      ...refusal.fields,
    });
    await writeFile(owner.claimPath, claim);
    expect(() => {
      checkpointRunOwner(
        owner,
        [{ trial: 1, artifactPath: "new-trial.json" }],
        "complete",
      );
    }).toThrow(refusal.message);
    expect(await readFile(paths.checkpointPath, "utf8")).toBe(checkpoint);
    expect(await readFile(paths.activeRunPath, "utf8")).toBe(active);
    expect(await readFile(owner.claimPath, "utf8")).toBe(claim);
  });
}

test("refuses a checkpoint when its claim disappears without rewriting evidence", async () => {
  const paths = await ownership();
  const owner = startRunOwner(paths);
  const checkpoint = await readFile(paths.checkpointPath, "utf8");
  const active = await readFile(paths.activeRunPath, "utf8");
  await rm(owner.claimPath);
  expect(() => {
    checkpointRunOwner(owner, [], "complete");
  }).toThrow("ownership changed before checkpoint");
  expect(await readFile(paths.checkpointPath, "utf8")).toBe(checkpoint);
  expect(await readFile(paths.activeRunPath, "utf8")).toBe(active);
});

test("reclaims a stale process identity with a missing active record while retaining interrupted provenance", async () => {
  const paths = await ownership();
  const prior = startRunOwner(paths);
  const claim = parseOwner(await readFile(prior.claimPath, "utf8"));
  await writeFile(
    prior.claimPath,
    JSON.stringify({
      ...claim,
      owner: { ...claim.owner, startedAt: "previous process instance" },
    }),
  );
  await rm(paths.activeRunPath);
  const nextPaths = {
    ...paths,
    attemptId: randomUUID(),
    activeRunPath: join(paths.stateRoot, "active", "next.json"),
    checkpointPath: join(paths.stateRoot, "next", "checkpoint.json"),
    evidenceDirectory: join(paths.stateRoot, "next"),
  };
  const next = startRunOwner(nextPaths);
  const interrupted = parseRecord(await readFile(paths.activeRunPath, "utf8"));
  expect(interrupted.status).toBe("interrupted");
  expect(interrupted.runId).toBe(paths.attemptId);
  expect(interrupted.artifactPath).toBe(paths.artifactPath);
  expect(interrupted.completedTrials).toEqual([]);
  expect(
    parseRecord(
      await readFile(join(paths.evidenceDirectory, "run-owner.json"), "utf8"),
    ).status,
  ).toBe("interrupted");
  expect(next.claim.attemptId).toBe(nextPaths.attemptId);
  expect(
    parseRecord(await readFile(nextPaths.activeRunPath, "utf8")).status,
  ).toBe("active");
});

test("refuses a stale owner with malformed active evidence without discarding its record", async () => {
  const paths = await ownership();
  const owner = startRunOwner(paths);
  const claim = JSON.stringify({
    ...parseOwner(await readFile(owner.claimPath, "utf8")),
    owner: { ...owner.claim.owner, startedAt: "previous process instance" },
  });
  await writeFile(owner.claimPath, claim);
  await writeFile(paths.activeRunPath, "{broken retained evidence");
  expect(() => startRunOwner({ ...paths, attemptId: randomUUID() })).toThrow();
  expect(await readFile(owner.claimPath, "utf8")).toBe(claim);
  expect(await readFile(paths.activeRunPath, "utf8")).toBe(
    "{broken retained evidence",
  );
});

for (const replacement of [
  { name: "foreign host", fields: { host: "another-host.example" } },
  { name: "invalid PID", fields: { pid: 0 } },
  { name: "missing process start", fields: { startedAt: "" } },
]) {
  test(`refuses an owner with ${replacement.name} without replacing its evidence`, async () => {
    const paths = await ownership();
    const owner = startRunOwner(paths);
    const original = parseOwner(await readFile(owner.claimPath, "utf8"));
    const bytes = JSON.stringify({
      ...original,
      owner: { ...original.owner, ...replacement.fields },
    });
    const active = await readFile(paths.activeRunPath, "utf8");
    await writeFile(owner.claimPath, bytes);
    expect(() => startRunOwner({ ...paths, attemptId: randomUUID() })).toThrow(
      "ownership is unverifiable",
    );
    expect(await readFile(owner.claimPath, "utf8")).toBe(bytes);
    expect(await readFile(paths.activeRunPath, "utf8")).toBe(active);
  });
}

test("refuses a retained claim for another evaluation identity without changing it", async () => {
  const paths = await ownership();
  const owner = startRunOwner(paths);
  const bytes = JSON.stringify({
    ...parseRecord(await readFile(owner.claimPath, "utf8")),
    evaluationDigest: "d".repeat(64),
  });
  await writeFile(owner.claimPath, bytes);
  expect(() => startRunOwner({ ...paths, attemptId: randomUUID() })).toThrow(
    "ownership record has a different identity",
  );
  expect(await readFile(owner.claimPath, "utf8")).toBe(bytes);
});

test("keeps an owner active and removes temporary files when checkpoint persistence fails", async () => {
  const paths = await ownership();
  const owner = startRunOwner(paths);
  const claim = await readFile(owner.claimPath, "utf8");
  const active = await readFile(paths.activeRunPath, "utf8");
  await rm(paths.checkpointPath);
  await mkdir(paths.checkpointPath);
  expect(() => {
    checkpointRunOwner(
      owner,
      [{ trial: 1, artifactPath: "retained-trial.json" }],
      "complete",
    );
  }).toThrow();
  expect(await readFile(owner.claimPath, "utf8")).toBe(claim);
  expect(await readFile(paths.activeRunPath, "utf8")).toBe(active);
  expect(await readdir(paths.evidenceDirectory)).toEqual(["checkpoint.json"]);
  expect(owner.claim.status).toBe("active");
});
