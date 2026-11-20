import type { RuntimeArtifactDirectory } from "./artifact-directories";
import type { RuntimeDiscoverySource } from "./discovery";

/** Canonical roles; schemas:generate projects this list into the runtime schema. */
export const RUNTIME_ROLES = [
  "candidate",
  "checks",
  "hooks",
  "semantic",
  "advisory",
] as const;
export type RuntimeRole = (typeof RUNTIME_ROLES)[number];
export interface RuntimeSeed {
  source: string;
  target: string;
  roles?: RuntimeRole[];
}
export interface SharedCacheDirectory {
  source: string;
  target: string;
  roles: RuntimeRole[];
}
export interface RuntimeConfiguration {
  format: "sevro.runtime.v1";
  codexState?: boolean;
  network?: { localHttp?: boolean };
  nativeTranscripts?: boolean;
  environment?: { inherit?: string[]; set?: Record<string, string> };
  filesystem?: { readOnlyRoots?: string[]; optionalReadOnlyRoots?: string[] };
  runtime?: {
    seedDirectories?: RuntimeSeed[];
    sharedCacheDirectories?: SharedCacheDirectory[];
    artifactDirectories?: RuntimeArtifactDirectory[];
  };
  hooks?: { nativeGoal?: boolean; plugins?: string[] };
}

export interface RuntimePolicy {
  format: "sevro.runtime.v1";
  codexState?: boolean;
  network?: { localHttp?: boolean };
  artifactDirectories?: RuntimeArtifactDirectory[];
  nativeTranscripts?: boolean;
  environment: Record<string, string>;
  readOnlyRoots: string[];
  discovery?: RuntimeDiscoverySource[];
  skippedOptionalReadOnlyRoots?: string[];
  /** Original source denials retained when a derived role policy omits seeds. */
  seedReadDenyRoots?: string[];
  seeds?: (RuntimeSeed & { sha256: string })[];
  sharedCacheDirectories?: SharedCacheDirectory[];
  hooks?: { nativeGoal?: boolean; plugins?: string[] };
}
