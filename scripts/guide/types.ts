export type GuideCase = {
  id: string;
  prompt: string;
  activation: boolean;
  fixture?: string;
  checks: string[];
  followUp?: string;
  followUpChecks?: string[];
};
export type GuideEvent = Record<string, unknown>;
export type Turn = {
  answer: string;
  events: GuideEvent[];
  code: number;
  diagnostic: string;
};
export type NativeInvocation = { accepted: boolean | null; reason: string };
export type Host = "codex" | "claude";
export type CaseResult = {
  id: string;
  passed: boolean;
  checks?: Record<string, boolean>;
  diagnostic?: string;
};
