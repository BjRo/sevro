import { expect, test } from "bun:test";
import { claudeHostSettings } from "../src/hosts/claude-settings";

test("Claude host settings deny private state to Bash and file tools", () => {
  const settings = claudeHostSettings(
    "/private/sevro-state",
    "/private/sevro-state/config/.credentials.json",
    ["/private/workspace/plugin"],
  ) as {
    sandbox: {
      enabled: boolean;
      allowUnsandboxedCommands: boolean;
      failIfUnavailable: boolean;
      filesystem: { denyRead: string[]; denyWrite: string[] };
      credentials: { files: Array<{ path: string; mode: string }> };
    };
    permissions: { allow: string[]; deny: string[] };
  };
  expect(settings.sandbox).toMatchObject({
    enabled: true,
    allowUnsandboxedCommands: false,
    failIfUnavailable: true,
    filesystem: {
      denyRead: ["/private/sevro-state"],
      denyWrite: ["/private/sevro-state", "/private/workspace/plugin"],
    },
    credentials: {
      files: [
        {
          path: "/private/sevro-state/config/.credentials.json",
          mode: "deny",
        },
      ],
    },
  });
  expect(settings.permissions.deny).toEqual([
    "Read(//private/sevro-state/**)",
    "Edit(//private/sevro-state/**)",
    "Edit(//private/workspace/plugin/**)",
  ]);
  expect(settings.permissions.allow).toContain("Bash");
  expect(settings.permissions.allow).toContain("Agent");
});

test("Claude host settings reject escaping and malformed state paths", () => {
  expect(() => claudeHostSettings("relative", "/tmp/config")).toThrow();
  expect(() => claudeHostSettings("/tmp/state", "/tmp/other")).toThrow();
  expect(() => claudeHostSettings("/tmp/(bad)", "/tmp/(bad)/config")).toThrow();
});
