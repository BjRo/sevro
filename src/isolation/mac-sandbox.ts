import { randomUUID } from "node:crypto";
import { containsControl } from "../kernel/index";
import { existsSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { insideRuntimeRoot, isRuntimeHomeRoot } from "../runtime/index";
import { workspaceBoundaryException } from "../workspace/index";
import { HostIsolationError, type IsolatedCommand } from "./isolation-common";
import type { IsolationPolicy } from "./policy";

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

function quoted(path: string): string {
  if (containsControl(path))
    throw new HostIsolationError("sandbox path contains a control character");
  return path.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

/** Protect canonical roots while preserving explicitly granted access. */
export function macSandboxProfile(policy: IsolationPolicy): string {
  const deniedRoots = policy.deny;
  const readOnlyRoots = policy.read.runtime;
  const writableRuntimeRoot = policy.write.runtime;
  const transcriptReadRoots = [
    ...policy.read.transcripts,
    ...policy.read.hooks,
    ...policy.read.artifacts,
  ];
  const workspace = policy.workspace;
  const writableCacheRoots = policy.write.caches;
  const denyNetwork = policy.network !== "allowed";
  const localHttp = policy.network === "local-http";
  return (
    [
      "(version 1)",
      "(allow default)",
      ...(denyNetwork ? ["(deny network*)"] : []),
      ...localHttpRules(localHttp),
      ...[...new Set(deniedRoots)]
        .sort()
        .flatMap((path) => [
          `(deny file-read* ${workspaceReadFilter(path, readExceptions(path, readOnlyRoots, writableRuntimeRoot, transcriptReadRoots, workspace, writableCacheRoots), workspace)})`,
          `(deny file-write* ${rootFilter(path, [...writableExceptions(path, writableRuntimeRoot, writableCacheRoots), ...workspaceBoundaryException(path, workspace)])})`,
        ]),
      ...deniedRoots.flatMap((path) =>
        workspaceBoundaryException(path, workspace).map(
          () => `(deny file-read-data (literal "${quoted(path)}"))`,
        ),
      ),
      ...[...readOnlyRoots, ...transcriptReadRoots].map(
        (path) => `(deny file-write* (subpath "${quoted(path)}"))`,
      ),
      ...deniedRoots.flatMap((root) =>
        ancestorMetadataRules(
          root,
          readExceptions(
            root,
            readOnlyRoots,
            writableRuntimeRoot,
            transcriptReadRoots,
            workspace,
            writableCacheRoots,
          ),
        ),
      ),
      "",
    ].join("\n") +
    (policy.hideProcessInfo
      ? "\n(deny process-info* (require-not (target self)))\n"
      : "")
  );
}

function localHttpRules(enabled: boolean | undefined): string[] {
  return enabled
    ? [
        '(allow network-bind (local ip "*:*"))',
        '(allow network-inbound (local ip "localhost:*"))',
        '(allow network-outbound (remote ip "localhost:*"))',
      ]
    : [];
}

function ancestorMetadataRules(root: string, readRoots: string[]): string[] {
  const ancestors = new Set<string>();
  for (const readRoot of readRoots) {
    for (
      let path = dirname(readRoot);
      insideRuntimeRoot(root, path);
      path = dirname(path)
    ) {
      ancestors.add(path);
      if (path === resolve(root)) break;
    }
  }
  return [...ancestors]
    .sort()
    .map((path) => `(allow file-read-metadata (literal "${quoted(path)}"))`);
}

function readExceptions(
  root: string,
  readRoots: string[],
  writableRuntimeRoot: string | undefined,
  transcriptReadRoots: string[],
  workspace?: string,
  writableCacheRoots: string[] = [],
): string[] {
  const exceptions = isRuntimeHomeRoot(root)
    ? readRoots.filter((path) => insideRuntimeRoot(root, path))
    : [];
  return [
    ...transcriptReadRoots.filter((path) => insideRuntimeRoot(root, path)),
    ...exceptions,
    ...writableExceptions(root, writableRuntimeRoot, writableCacheRoots),
    ...workspaceBoundaryException(root, workspace),
  ];
}

function writableExceptions(
  root: string,
  runtime: string | undefined,
  caches: string[] = [],
): string[] {
  return [
    ...ownedException(root, runtime),
    ...caches.flatMap((cache) => ownedException(root, cache)),
  ];
}

function rootFilter(root: string, exceptions: string[]): string {
  const base = `(subpath "${quoted(root)}")`;
  if (!exceptions.length) return base;
  return `(require-all ${base} ${exceptions.map((path) => `(require-not (subpath "${quoted(path)}"))`).join(" ")})`;
}

function workspaceReadFilter(
  root: string,
  exceptions: string[],
  workspace?: string,
): string {
  const filter = rootFilter(root, exceptions);
  return workspaceBoundaryException(root, workspace).length
    ? `(require-all ${filter} (require-not (literal "${quoted(root)}")))`
    : filter;
}

function ownedException(root: string, ownedRoot: string | undefined): string[] {
  if (ownedRoot && insideRuntimeRoot(root, ownedRoot)) return [ownedRoot];
  return [];
}

/** Build the outer boundary before launching an agent or candidate-controlled code. */
export async function prepareMacSandboxCommand(
  policy: IsolationPolicy,
  argv: string[],
  profilePath = resolve(policy.privateStateRoot, `host-${randomUUID()}.sb`),
): Promise<IsolatedCommand> {
  requireSandboxAvailable();
  await writeFile(profilePath, macSandboxProfile(policy), {
    flag: "wx",
    mode: 0o600,
  });
  return {
    argv: [SANDBOX_EXEC, "-f", profilePath, ...argv],
    release: async () => {
      await rm(profilePath, { force: true });
    },
  };
}

function requireSandboxAvailable(): void {
  if (process.platform !== "darwin" || !existsSync(SANDBOX_EXEC))
    throw new HostIsolationError("macOS sandbox-exec isolation is unavailable");
}
