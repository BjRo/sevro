import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { sha256 } from "./identity";
import type { HostResult } from "./evaluation-types";
import type { RuntimeRole } from "./runtime-state";
import type { RuntimePolicy } from "./runtime-config";
import { isRecord } from "./value-guards";

export function candidateTranscriptRoots(root: string | undefined): string[] {
  return root ? [root] : [];
}

export function candidateTranscriptEnvironment(
  root: string | undefined,
): Record<string, string> {
  return root ? { SEVRO_CANDIDATE_TRANSCRIPTS: root } : {};
}

export async function retainEnabledNativeTranscripts(
  result: HostResult,
  policy: RuntimePolicy | undefined,
  root: string,
  host: "codex" | "claude",
  role?: RuntimeRole,
  rootSessionId?: string,
): Promise<void> {
  if (policy?.nativeTranscripts === true)
    await retainNativeTranscripts(
      result,
      root,
      host,
      role,
      rootSessionId ?? observedRootSession(result),
    );
}

function observedRootSession(result: HostResult): string | undefined {
  const observation = result.observations?.find(
    (item) => item.id === "sevro.host.native-goal",
  );
  const session = observation?.data.threadId;
  return typeof session === "string" ? session : undefined;
}

export async function failedNativeTranscripts(
  cause: unknown,
  policy: RuntimePolicy | undefined,
  root: string,
  host: "codex" | "claude",
  role?: RuntimeRole,
): Promise<HostResult> {
  if (policy?.nativeTranscripts !== true) throw cause;
  const result: HostResult = {
    finalMessage: null,
    complete: false,
    executionFailed: true,
    actualCondition: "passive",
  };
  await retainNativeTranscripts(result, root, host, role);
  return result;
}

const MAX_FILES = 4096;
const MAX_BYTES = 5 * 1024 * 1024;
const MAX_ENCODED_FILES_BYTES = 7 * 1024 * 1024;
type NativeFile = { path: string; sha256: string; bytesBase64: string };
type Capture = {
  files: NativeFile[];
  bytes: number;
  entries: number;
  encodedBytes: number;
  issues: string[];
};

/** Capture only a fresh role's transcript tree; never follow native source links. */
export async function retainNativeTranscripts(
  result: HostResult,
  root: string,
  host: "codex" | "claude",
  role: RuntimeRole = "candidate",
  rootSessionId: string | null = null,
): Promise<void> {
  const capture: Capture = {
    files: [],
    bytes: 0,
    entries: 0,
    encodedBytes: 0,
    issues: [],
  };
  try {
    await captureDirectory(root, "", capture);
  } catch {
    capture.issues.push("source_unavailable");
  }
  observeCaptureRoot(capture, rootSessionId, host);
  const completeness = captureCompleteness(capture, result);
  const bundle = {
    format: "sevro.native-transcripts.v1",
    host,
    role,
    rootSessionId,
    completeness,
    issues: capture.issues,
    files: capture.files,
  };
  const lists = nativeResultLists(result);
  lists.artifacts.push({
    id: "sevro.native-transcripts.bundle",
    bytes: Buffer.from(JSON.stringify(bundle)),
  });
  lists.observations.push({
    id: "sevro.host.native-transcripts",
    completeness,
    data: {
      method: "native_files",
      host,
      role,
      rootSessionId,
      artifactId: "sevro.native-transcripts.bundle",
      issues: capture.issues,
      files: capture.files.map(({ path, sha256 }) => ({ path, sha256 })),
    },
  });
}

function nativeResultLists(result: HostResult) {
  result.artifacts ??= [];
  result.observations ??= [];
  return { artifacts: result.artifacts, observations: result.observations };
}

function observeCaptureRoot(
  capture: Capture,
  session: string | null,
  host: string,
): void {
  if (session === null) {
    capture.issues.push("root_session_unknown");
    return;
  }
  const suffix = host === "codex" ? `-${session}.jsonl` : `/${session}.jsonl`;
  if (!capture.files.some((file) => file.path.endsWith(suffix)))
    capture.issues.push("root_session_missing");
}

function captureCompleteness(capture: Capture, result: HostResult) {
  if (!capture.files.some((file) => file.path.endsWith(".jsonl")))
    return "unavailable" as const;
  if (capture.issues.length || !result.complete || result.executionFailed)
    return "partial" as const;
  return "complete" as const;
}

async function captureDirectory(
  root: string,
  path: string,
  capture: Capture,
): Promise<void> {
  const directory = join(root, path);
  if (!(await lstat(directory)).isDirectory())
    throw new Error("invalid source directory");
  for (const name of (await readdir(directory)).sort()) {
    capture.entries++;
    if (capture.entries > MAX_FILES) {
      capture.issues.push("entry_limit");
      return;
    }
    await captureEntry(root, join(path, name), capture);
  }
}

async function captureEntry(
  root: string,
  path: string,
  capture: Capture,
): Promise<void> {
  try {
    const info = await lstat(join(root, path));
    if (info.isDirectory()) {
      await captureDirectory(root, path, capture);
      return;
    }
    if (!info.isFile()) {
      capture.issues.push("unsafe_entry");
      return;
    }
    await captureFile(root, path, info.size, capture);
  } catch {
    capture.issues.push("entry_unavailable");
  }
}

async function captureFile(
  root: string,
  path: string,
  size: number,
  capture: Capture,
): Promise<void> {
  if (capture.bytes + size > MAX_BYTES) {
    capture.issues.push("byte_limit");
    return;
  }
  const bytes = await readFile(join(root, path));
  if (bytes.length !== size) {
    capture.issues.push("source_changed");
    return;
  }
  const file = {
    path,
    sha256: sha256(bytes),
    bytesBase64: bytes.toString("base64"),
  };
  const issue = nativeFileIssue(path, bytes);
  if (issue && !capture.issues.includes(issue)) capture.issues.push(issue);
  retainCaptureFile(file, bytes.length, capture);
}

function nativeFileIssue(path: string, bytes: Buffer): string | null {
  if (path.endsWith(".json")) return nativeSidecarIssue(bytes);
  if (!path.endsWith(".jsonl")) return null;
  return nativeTranscriptIssue(bytes);
}

function nativeTranscriptIssue(bytes: Buffer): string | null {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (!text.trim()) return "empty_transcript";
    const records = text.replace(/\r?\n$/, "").split("\n");
    if (!records.every(validNativeRecord)) return "malformed_transcript";
    return null;
  } catch {
    return "malformed_transcript";
  }
}

function nativeSidecarIssue(bytes: Buffer): string | null {
  try {
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    return null;
  } catch {
    return "malformed_sidecar";
  }
}

function validNativeRecord(line: string): boolean {
  const record: unknown = JSON.parse(line);
  return isRecord(record) && nativeRecordType(record.type);
}

function nativeRecordType(type: unknown): boolean {
  return typeof type === "string" && type.trim().length > 0;
}

function retainCaptureFile(
  file: NativeFile,
  size: number,
  capture: Capture,
): void {
  const encoded = Buffer.byteLength(JSON.stringify(file));
  if (capture.encodedBytes + encoded > MAX_ENCODED_FILES_BYTES) {
    capture.issues.push("bundle_limit");
    return;
  }
  capture.bytes += size;
  capture.encodedBytes += encoded;
  capture.files.push(file);
}
