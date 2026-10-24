import { afterEach, expect, test } from "bun:test";
import { createTemporaryFixtures } from "../../fixtures/filesystem";
import {
  fixture,
  invoke,
  localeCases,
  localeHostArguments,
} from "../../fixtures/runtime-cli";

const roots: string[] = [];
const { cleanupTemporaryFixtures } = createTemporaryFixtures(roots);
afterEach(cleanupTemporaryFixtures);

test.each(localeCases)(
  "CLI isolated shell locale uses the caller default when LANG is $name",
  async ({ lang, expected }) => {
    const { args } = await fixture(roots, [
      {
        id: "locale",
        grader: "sevro.shell",
        configuration: { run: 'printf "%s" "$LANG"', expectExact: expected },
      },
    ]);
    const run = await invoke([...args, "--shell-isolation"], { LANG: lang });
    expect(run.code, JSON.stringify(run.result)).toBe(0);
    expect(run.result.task.verdict).toBe("passed");
  },
);

for (const route of ["codex", "claude"] as const) {
  test.each(localeCases)(
    `CLI ${route} candidate locale uses the caller default when LANG is $name`,
    async ({ lang, pattern }) => {
      const { root, args } = await fixture(roots, [
        {
          id: "locale",
          grader: "sevro.regex",
          configuration: { pattern },
        },
      ]);
      const native = args.filter(
        (_value, index) =>
          index !== args.indexOf("--adapter-module") &&
          index !== args.indexOf("--adapter-module") + 1,
      );
      const hostArguments = await localeHostArguments(route, root);
      const run = await invoke(
        [
          ...native,
          "--host",
          route,
          ...hostArguments,
          "--model",
          "synthetic",
          "--effort",
          "low",
        ],
        { LANG: lang },
      );
      expect(run.code, JSON.stringify(run.result)).toBe(0);
      expect(run.result.task.verdict).toBe("passed");
    },
  );
}
