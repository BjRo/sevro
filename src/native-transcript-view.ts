import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";
import { allocateNativeState } from "./native-transcript-state";
import { fixtureParts } from "./fixtures/preparation";
import { isRecord, isUnknownArray } from "./value-guards";
import { sha256 } from "./identity";

const MAX_NATIVE_BYTES = 5 * 1024 * 1024;
type NativeFormat =
  "sevro.native-transcripts.v1" | "sevro.native-transcripts.v2";

export async function materializeNativeTranscriptView(
  bytes: Uint8Array,
): Promise<string> {
  const value: unknown = JSON.parse(Buffer.from(bytes).toString("utf8"));
  const bundle = nativeBundle(value);
  const root = await allocateNativeState("view-");
  await writeFile(join(root, "index.json"), bytes, { flag: "wx", mode: 0o600 });
  const filesRoot = join(root, bundle.host);
  let remainingBytes = MAX_NATIVE_BYTES;
  for (const item of bundle.files)
    remainingBytes -= await materializeNativeFile(
      filesRoot,
      item,
      bundle.format,
      remainingBytes,
    );
  return root;
}

function nativeBundle(value: unknown) {
  if (!isRecord(value) || !nativeFormat(value.format))
    throw new Error("invalid native transcript bundle");
  if (!nativeHost(value.host))
    throw new Error("invalid native transcript host");
  if (!isUnknownArray(value.files))
    throw new Error("invalid native transcript files");
  return { host: value.host, files: value.files, format: value.format };
}

function nativeFormat(value: unknown): value is NativeFormat {
  return (
    value === "sevro.native-transcripts.v1" ||
    value === "sevro.native-transcripts.v2"
  );
}

function nativeHost(value: unknown): value is "codex" | "claude" {
  return value === "codex" || value === "claude";
}

async function materializeNativeFile(
  root: string,
  value: unknown,
  format: NativeFormat,
  remainingBytes: number,
): Promise<number> {
  if (!isRecord(value) || typeof value.path !== "string")
    throw new Error("invalid native transcript file");
  const path = join(root, ...fixtureParts(value.path));
  const bytes = nativeFileBytes(value, format, remainingBytes);
  if (bytes.length > remainingBytes)
    throw new Error("native transcript byte limit exceeded");
  if (sha256(bytes) !== value.sha256)
    throw new Error("native transcript hash mismatch");
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
  return bytes.length;
}

function nativeFileBytes(
  value: Record<string, unknown>,
  format: NativeFormat,
  remainingBytes: number,
): Buffer {
  const encoded =
    format === "sevro.native-transcripts.v1"
      ? value.bytesBase64
      : value.gzipBase64;
  if (typeof encoded !== "string")
    throw new Error("invalid native transcript file");
  const bytes = Buffer.from(encoded, "base64");
  if (format === "sevro.native-transcripts.v1") return bytes;
  try {
    return gunzipSync(bytes, { maxOutputLength: Math.max(1, remainingBytes) });
  } catch (cause) {
    throw new Error("invalid native transcript gzip", { cause });
  }
}
