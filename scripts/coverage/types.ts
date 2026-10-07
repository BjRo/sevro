import type { CoverageMapData } from "istanbul-lib-coverage";

export interface CoverageIdentity {
  version: number;
  runId: string;
  layout: string;
}
export interface CoverageParticipant extends CoverageIdentity {
  pid: number;
  ppid: number;
  argv: string[];
}
export interface CoverageRecord extends CoverageParticipant {
  completion: "checkpoint" | "complete";
  coverage: CoverageMapData;
}
export interface KilledParticipant extends CoverageParticipant {
  signal: "SIGKILL";
}
export interface Capture {
  dump: (completion?: "checkpoint" | "complete") => void;
  directory: string;
  identity: CoverageParticipant;
  writeRecord: (directory: string, name: string, record: unknown) => void;
}

export interface CounterExemption {
  branchId: string;
  outcome: number;
  location: import("istanbul-lib-coverage").Range;
  binding: string;
  guard: string;
}
export interface FileExemptions {
  file: string;
  sha256: string;
  proofs: CounterExemption[];
}
export interface ExemptionManifest {
  version: number;
  status: string;
  reasonId: string;
  instrumenter: string;
  files: FileExemptions[];
}
declare global {
  var __coverage__: CoverageMapData | undefined;
  var __sevroQualityCapture: Capture | undefined;
}
