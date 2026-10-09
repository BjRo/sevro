import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { allocateNativeState } from "./native-transcript-state";
import { fixtureParts } from "./preparation";
import { isRecord, isUnknownArray } from "./value-guards";
import { sha256 } from "./evaluation-fixture";

export async function materializeNativeTranscriptView(
  bytes: Uint8Array,
): Promise<string> {
  const value: unknown = JSON.parse(Buffer.from(bytes).toString("utf8"));
  const bundle = nativeBundle(value);
  const root = await allocateNativeState("view-");
  await writeFile(join(root, "index.json"), bytes, { flag: "wx", mode: 0o600 });
  for (const item of bundle.files)
    await materializeNativeFile(root, bundle.host, item);
  return root;
}

function nativeBundle(value: unknown) {
  if (!isRecord(value) || value.format !== "sevro.native-transcripts.v1")
    throw new Error("invalid native transcript bundle");
  if (!nativeHost(value.host))
    throw new Error("invalid native transcript host");
  if (!isUnknownArray(value.files))
    throw new Error("invalid native transcript files");
  return { host: value.host, files: value.files };
}

function nativeHost(value: unknown): value is "codex" | "claude" {
  return value === "codex" || value === "claude";
}

async function materializeNativeFile(
  root: string,
  host: string,
  value: unknown,
): Promise<void> {
  if (
    !isRecord(value) ||
    typeof value.path !== "string" ||
    typeof value.bytesBase64 !== "string"
  )
    throw new Error("invalid native transcript file");
  const path = join(root, host, ...fixtureParts(value.path));
  const bytes = Buffer.from(value.bytesBase64, "base64");
  if (sha256(bytes) !== value.sha256)
    throw new Error("native transcript hash mismatch");
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
}
