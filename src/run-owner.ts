import { isRecord } from "./value-guards";
import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { basename, dirname, join } from "node:path";

interface ProcessIdentity {
  pid: number;
  startedAt: string;
  host: string;
}

interface Claim {
  format: "sevro.run-owner.v1";
  evaluationDigest: string;
  attemptId: string;
  status: "active" | "complete" | "diagnostic" | "interrupted";
  owner: ProcessIdentity;
  activeRunPath: string;
  evidenceDirectory: string;
  artifactPath: string;
  startedAt: string;
  finalizedAt?: string;
}

interface RetainedClaim {
  format: "sevro.run-owner.v1";
  evaluationDigest: unknown;
  attemptId: unknown;
  status: Claim["status"];
  owner?: unknown;
  activeRunPath: string;
  evidenceDirectory: string;
  artifactPath: string;
  startedAt?: unknown;
  finalizedAt?: unknown;
}

function errorCode(error: unknown): unknown {
  return isRecord(error) ? error.code : undefined;
}
function nonemptyText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function validClaimStatus(value: unknown): value is Claim["status"] {
  return (
    value === "active" ||
    value === "complete" ||
    value === "diagnostic" ||
    value === "interrupted"
  );
}

function validClaimIdentity(value: Record<string, unknown>): boolean {
  return (
    value.format === "sevro.run-owner.v1" &&
    /^[a-f0-9]{64}$/.test(String(value.evaluationDigest)) &&
    Boolean(value.attemptId) &&
    validClaimStatus(value.status)
  );
}

function validClaimPaths(value: Record<string, unknown>): boolean {
  return (
    nonemptyText(value.activeRunPath) &&
    nonemptyText(value.evidenceDirectory) &&
    nonemptyText(value.artifactPath)
  );
}

function assertRetainedClaim(
  value: unknown,
  path: string,
): asserts value is RetainedClaim {
  if (!isRecord(value) || !validClaimIdentity(value) || !validClaimPaths(value))
    throw new Error(`unrecognized Sevro ownership record: ${path}`);
}

export interface RunOwner {
  claimPath: string;
  checkpointPath: string;
  claim: Claim;
}

function atomicJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = join(
    dirname(path),
    `.${basename(path)}.${randomUUID()}.tmp`,
  );
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    renameSync(temporary, path);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      // The temporary file may not have been created.
    }
    throw error;
  }
}

function withClaimLock<T>(claimPath: string, action: () => T): T {
  const locks = join(dirname(dirname(claimPath)), "locks");
  mkdirSync(locks, { recursive: true, mode: 0o700 });
  const database = new Database(join(locks, `${basename(claimPath)}.sqlite`));
  try {
    database.run("PRAGMA busy_timeout = 5000");
    database.run("CREATE TABLE IF NOT EXISTS mutex (id INTEGER PRIMARY KEY)");
    return database.transaction(action).immediate();
  } finally {
    database.close();
  }
}

function readClaim(path: string): RetainedClaim | null {
  let bytes: string;
  try {
    bytes = readFileSync(path, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
  const value: unknown = JSON.parse(bytes);
  assertRetainedClaim(value, path);
  return value;
}

function identityCommand(pid: number, windows: boolean): string[] {
  return windows
    ? [
        "powershell.exe",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`,
      ]
    : ["/bin/ps", "-p", String(pid), "-o", "lstart="];
}

function identityEnvironment(windows: boolean) {
  return windows
    ? {
        PATH: process.env.PATH ?? "",
        SystemRoot: process.env.SystemRoot ?? "C:\\Windows",
      }
    : { PATH: "/usr/bin:/bin", LC_ALL: "C" };
}

function processStartTime(result: ReturnType<typeof Bun.spawnSync>): string {
  return result.stdout?.toString().trim() ?? "";
}

function processIdentity(pid: number): ProcessIdentity | null {
  const windows = process.platform === "win32";
  const argv = identityCommand(pid, windows);
  let result: ReturnType<typeof Bun.spawnSync>;
  try {
    result = Bun.spawnSync(argv, {
      env: identityEnvironment(windows),
      stdout: "pipe",
      stderr: "ignore",
    });
  } catch {
    return null;
  }
  const startedAt = processStartTime(result);
  return result.exitCode === 0 && startedAt
    ? { pid, startedAt, host: hostname() }
    : null;
}

function validProcessId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function validProcessIdentity(value: unknown): value is ProcessIdentity {
  return (
    isRecord(value) &&
    value.host === hostname() &&
    validProcessId(value.pid) &&
    nonemptyText(value.startedAt)
  );
}

function processLiveness(pid: number): "live" | "dead" | "unknown" {
  try {
    process.kill(pid, 0);
    return "live";
  } catch (error) {
    return errorCode(error) === "ESRCH" ? "dead" : "unknown";
  }
}

function ownerStatus(owner: unknown): "live" | "dead" | "unknown" {
  if (!validProcessIdentity(owner)) return "unknown";
  const liveness = processLiveness(owner.pid);
  if (liveness !== "live") return liveness;
  const current = processIdentity(owner.pid);
  if (!current) return "unknown";
  return current.startedAt === owner.startedAt ? "live" : "dead";
}

function activeRunFields(value: unknown): Record<string, unknown> {
  if (value == null) return {};
  // Preserve the existing object-spread representation of opaque active records.
  const entries: [string, unknown][] = Object.entries(value);
  return Object.fromEntries(entries);
}

function preserveAbandoned(claim: RetainedClaim): void {
  const interrupted = {
    ...claim,
    status: "interrupted" as const,
    finalizedAt: new Date().toISOString(),
  };
  atomicJson(join(claim.evidenceDirectory, "run-owner.json"), interrupted);
  let active: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(claim.activeRunPath, "utf8"),
    );
    active = activeRunFields(parsed);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
    active = {
      format: "sevro.active-run.v1",
      runId: claim.attemptId,
      artifactPath: claim.artifactPath,
      evidenceDirectory: claim.evidenceDirectory,
      completedTrials: [],
    };
  }
  atomicJson(claim.activeRunPath, {
    ...active,
    status: "interrupted",
    finalizedAt: interrupted.finalizedAt,
  });
}

function validateClaimIdentityMatch(
  prior: RetainedClaim | null,
  evaluationDigest: string,
): void {
  if (prior && prior.evaluationDigest !== evaluationDigest)
    throw new Error("Sevro ownership record has a different identity");
}

function retainPreviousOwner(
  prior: RetainedClaim | null,
  claimPath: string,
): void {
  if (prior === null || prior.status !== "active") return;
  const status = ownerStatus(prior.owner);
  if (status === "live")
    throw new Error(`equivalent Sevro run is active: ${claimPath}`);
  if (status === "unknown")
    throw new Error(`Sevro run ownership is unverifiable: ${claimPath}`);
  preserveAbandoned(prior);
}

function validateCheckpointOwner(context: RunOwner): void {
  const current = readClaim(context.claimPath);
  if (!current || current.attemptId !== context.claim.attemptId)
    throw new Error("Sevro run ownership changed before checkpoint");
  if (current.status !== "active")
    throw new Error("Sevro run owner is already finalized");
  if (ownerStatus(current.owner) !== "live")
    throw new Error("Sevro run owner identity is no longer verifiable");
}

/** Claim one evaluation identity before candidate execution. */
export function startRunOwner(options: {
  stateRoot: string;
  evaluationDigest: string;
  attemptId: string;
  activeRunPath: string;
  checkpointPath: string;
  evidenceDirectory: string;
  artifactPath: string;
}): RunOwner {
  if (!/^[a-f0-9]{64}$/.test(options.evaluationDigest))
    throw new Error("invalid evaluation identity for run ownership");
  const claimPath = join(
    options.stateRoot,
    "owners",
    `${options.evaluationDigest}.json`,
  );
  return withClaimLock(claimPath, () => {
    const prior = readClaim(claimPath);
    validateClaimIdentityMatch(prior, options.evaluationDigest);
    retainPreviousOwner(prior, claimPath);
    const owner = processIdentity(process.pid);
    if (!owner) throw new Error("cannot verify Sevro runner process identity");
    const claim: Claim = {
      format: "sevro.run-owner.v1",
      evaluationDigest: options.evaluationDigest,
      attemptId: options.attemptId,
      status: "active",
      owner,
      activeRunPath: options.activeRunPath,
      evidenceDirectory: options.evidenceDirectory,
      artifactPath: options.artifactPath,
      startedAt: new Date().toISOString(),
    };
    const context = {
      claimPath,
      checkpointPath: options.checkpointPath,
      claim,
    };
    checkpointRunOwner(context, [], "active", true);
    return context;
  });
}

/** Persist a checkpoint only while this attempt owns the identity. */
export function checkpointRunOwner(
  context: RunOwner,
  completedTrials: { trial: number; artifactPath: string }[],
  status: "active" | "complete" | "diagnostic" | "interrupted",
  alreadyLocked = false,
): void {
  const write = () => {
    if (!alreadyLocked) validateCheckpointOwner(context);
    const finalizedAt =
      status === "active" ? undefined : new Date().toISOString();
    const updatedClaim = {
      ...context.claim,
      status,
      ...(finalizedAt ? { finalizedAt } : {}),
    };
    atomicJson(context.checkpointPath, {
      format: "sevro.run-checkpoint.v1",
      runId: context.claim.attemptId,
      completedTrials,
    });
    atomicJson(context.claim.activeRunPath, {
      format: "sevro.active-run.v1",
      runId: context.claim.attemptId,
      evaluationDigest: context.claim.evaluationDigest,
      attemptId: context.claim.attemptId,
      status,
      owner: context.claim.owner,
      artifactPath: context.claim.artifactPath,
      evidenceDirectory: context.claim.evidenceDirectory,
      checkpointPath: context.checkpointPath,
      completedTrials,
      ...(finalizedAt ? { finalizedAt } : {}),
    });
    atomicJson(context.claimPath, updatedClaim);
    context.claim = updatedClaim;
  };
  if (alreadyLocked) write();
  else withClaimLock(context.claimPath, write);
}
